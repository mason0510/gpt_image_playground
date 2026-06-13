package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	limitedFreeSentinel = "__IMAGINATION_SPACE_LIMITED_FREE_KEY__"
	limitedFreeHeader   = "X-Imagination-Space-Key-Mode"
	limitedFreeValue    = "limited-free"
	deviceHeader        = "X-Imagination-Space-Device-Fingerprint"
	defaultDailyLimit   = 10
	maxImagesPerRequest = 4
)

var hopByHopHeaders = map[string]struct{}{
	"Connection":          {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
}

type config struct {
	ListenAddr          string
	UpstreamBase        *url.URL
	LimitedFreeKey      string
	LimitedFreeDailyMax int
	RateLimitSalt       string
	RateLimitStorePath  string
}

type usageRecord struct {
	Day   string `json:"day"`
	Count int    `json:"count"`
}

type freeUsageLimiter struct {
	mu        sync.Mutex
	records   map[string]usageRecord
	dailyMax  int
	salt      string
	storePath string
	now       func() time.Time
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           newProxyHandler(cfg),
		ReadHeaderTimeout: 30 * time.Second,
	}

	log.Printf(
		"imagination-space-api-proxy listening on %s upstream=%s limited_free_key_configured=%t limited_free_daily_max=%d rate_limit_store_configured=%t",
		cfg.ListenAddr,
		cfg.UpstreamBase.Redacted(),
		cfg.LimitedFreeKey != "",
		cfg.LimitedFreeDailyMax,
		cfg.RateLimitStorePath != "",
	)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务退出: %v", err)
	}
}

func loadConfig() (config, error) {
	listenAddr := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if listenAddr == "" {
		listenAddr = "127.0.0.1:48190"
	}

	upstreamRaw := strings.TrimSpace(os.Getenv("UPSTREAM_BASE_URL"))
	if upstreamRaw == "" {
		upstreamRaw = "https://sub-lb.tap365.org"
	}
	upstream, err := url.Parse(upstreamRaw)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return config{}, fmt.Errorf("UPSTREAM_BASE_URL 无效")
	}
	upstream.Path = strings.TrimRight(upstream.Path, "/")

	dailyMax := defaultDailyLimit
	if raw := strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_LIMITED_FREE_DAILY_MAX")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			return config{}, fmt.Errorf("IMAGINATION_SPACE_LIMITED_FREE_DAILY_MAX 必须是正整数")
		}
		dailyMax = parsed
	}

	return config{
		ListenAddr:          listenAddr,
		UpstreamBase:        upstream,
		LimitedFreeKey:      strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_LIMITED_FREE_API_KEY")),
		LimitedFreeDailyMax: dailyMax,
		RateLimitSalt:       strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_RATE_LIMIT_SALT")),
		RateLimitStorePath:  strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_RATE_LIMIT_STORE_PATH")),
	}, nil
}

func newProxyHandler(cfg config) http.Handler {
	client := &http.Client{Timeout: 15 * time.Minute}
	limiter := newFreeUsageLimiter(cfg)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}

		limitedFree := isLimitedFreeRequest(r)
		if limitedFree {
			if cfg.LimitedFreeKey == "" {
				writeProxyError(w, http.StatusServiceUnavailable, "限时免费 key 暂不可用，请填写自己的 API Key")
				return
			}
			delta, body, err := readLimitedFreeRouteCost(r)
			if err != nil {
				var routeErr limitedFreeRouteError
				if errors.As(err, &routeErr) {
					writeJSON(w, http.StatusForbidden, map[string]any{
						"error": map[string]any{
							"message": "限时免费 key 仅支持图片生成接口，请切换为自己的 API Key 后使用其他接口。",
							"type":    "invalid_request_error",
							"code":    "limited_free_endpoint_not_allowed",
						},
					})
					return
				}
				writeProxyError(w, http.StatusBadRequest, "限时免费额度校验失败：请求体格式无效")
				return
			}
			if body != nil {
				r.Body = io.NopCloser(bytes.NewReader(body))
			}
			if delta > 0 {
				if delta > maxImagesPerRequest {
					w.Header().Set("X-Imagination-Space-Free-Max-Per-Request", strconv.Itoa(maxImagesPerRequest))
					writeJSON(w, http.StatusBadRequest, map[string]any{
						"error": map[string]any{
							"message":   fmt.Sprintf("限时免费 key 单次最多生成 %d 张图，请降低数量后重试。", maxImagesPerRequest),
							"type":      "invalid_request_error",
							"code":      "free_request_image_limit",
							"limit":     maxImagesPerRequest,
							"requested": delta,
						},
					})
					return
				}
				result := limiter.Allow(r, delta)
				if !result.Allowed {
					writeJSON(w, http.StatusTooManyRequests, map[string]any{
						"error": map[string]any{
							"message": "限时免费 key 今日免费体验额度已用完。请明天再试，或切换为自己的 API Key。",
							"type":    "rate_limit_exceeded",
							"code":    "free_daily_limit",
						},
					})
					return
				}
			}
		}

		upstreamURL := buildUpstreamURL(cfg.UpstreamBase, r.URL)
		outReq, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL.String(), r.Body)
		if err != nil {
			writeProxyError(w, http.StatusBadGateway, "代理请求创建失败")
			return
		}
		copyRequestHeaders(outReq.Header, r.Header)
		setForwardedHeaders(outReq, r)

		if limitedFree {
			outReq.Header.Set("Authorization", "Bearer "+cfg.LimitedFreeKey)
			outReq.Header.Del(limitedFreeHeader)
			outReq.Header.Del(deviceHeader)
		}

		resp, err := client.Do(outReq)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(r.Context().Err(), context.Canceled) {
				return
			}
			log.Printf("upstream_error method=%s path=%s err=%v", r.Method, sanitizePath(r.URL), err)
			writeProxyError(w, http.StatusBadGateway, "上游代理请求失败")
			return
		}
		defer resp.Body.Close()

		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			log.Printf("copy_response_error method=%s path=%s err=%v", r.Method, sanitizePath(r.URL), err)
		}
	})
}

type allowResult struct {
	Allowed   bool
	Limit     int
	Used      int
	Remaining int
}

func newFreeUsageLimiter(cfg config) *freeUsageLimiter {
	limiter := &freeUsageLimiter{
		records:   map[string]usageRecord{},
		dailyMax:  cfg.LimitedFreeDailyMax,
		salt:      cfg.RateLimitSalt,
		storePath: cfg.RateLimitStorePath,
		now:       time.Now,
	}
	if limiter.dailyMax < 1 {
		limiter.dailyMax = defaultDailyLimit
	}
	if limiter.salt == "" {
		limiter.salt = cfg.LimitedFreeKey
	}
	if limiter.storePath == "" {
		limiter.storePath = filepath.Join(os.TempDir(), "imagination-space-limited-free-usage.json")
	}
	limiter.load()
	return limiter
}

func (l *freeUsageLimiter) Allow(r *http.Request, delta int) allowResult {
	if delta < 1 {
		delta = 1
	}
	today := l.now().In(time.Local).Format("2006-01-02")
	key := l.deviceKey(r, today)

	l.mu.Lock()
	defer l.mu.Unlock()

	record := l.records[key]
	if record.Day != today {
		record = usageRecord{Day: today}
	}
	if record.Count+delta > l.dailyMax {
		return allowResult{Allowed: false, Limit: l.dailyMax, Used: record.Count, Remaining: maxInt(0, l.dailyMax-record.Count)}
	}
	record.Count += delta
	l.records[key] = record
	l.saveLocked()
	return allowResult{Allowed: true, Limit: l.dailyMax, Used: record.Count, Remaining: maxInt(0, l.dailyMax-record.Count)}
}

func (l *freeUsageLimiter) deviceKey(r *http.Request, today string) string {
	parts := []string{
		"v1",
		today,
		l.salt,
		clientIP(r),
		strings.TrimSpace(r.UserAgent()),
		strings.TrimSpace(r.Header.Get("Accept-Language")),
		strings.TrimSpace(r.Header.Get(deviceHeader)),
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}

func (l *freeUsageLimiter) load() {
	if l.storePath == "" {
		return
	}
	data, err := os.ReadFile(l.storePath)
	if err != nil {
		return
	}
	var records map[string]usageRecord
	if err := json.Unmarshal(data, &records); err != nil {
		log.Printf("rate_limit_store_load_error err=%v", err)
		return
	}
	if records != nil {
		l.records = records
	}
}

func (l *freeUsageLimiter) saveLocked() {
	if l.storePath == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(l.storePath), 0o755); err != nil {
		log.Printf("rate_limit_store_mkdir_error err=%v", err)
		return
	}
	data, err := json.Marshal(l.records)
	if err != nil {
		log.Printf("rate_limit_store_marshal_error err=%v", err)
		return
	}
	tmp := l.storePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		log.Printf("rate_limit_store_write_error err=%v", err)
		return
	}
	if err := os.Rename(tmp, l.storePath); err != nil {
		log.Printf("rate_limit_store_rename_error err=%v", err)
		return
	}
}

type limitedFreeRouteError struct{}

func (limitedFreeRouteError) Error() string {
	return "limited free endpoint not allowed"
}

func readLimitedFreeRouteCost(r *http.Request) (int, []byte, error) {
	path := r.URL.EscapedPath()
	if r.Method == http.MethodGet && (strings.HasSuffix(path, "/v1/models") || strings.HasSuffix(path, "/models")) {
		return 0, nil, nil
	}
	if r.Method != http.MethodPost || !strings.Contains(path, "/images/") {
		return 0, nil, limitedFreeRouteError{}
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return 0, nil, err
	}
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if contentType != "" && !strings.Contains(contentType, "json") {
		return 1, body, nil
	}
	var payload struct {
		N any `json:"n"`
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			return 0, body, err
		}
	}
	return parseImageCount(payload.N), body, nil
}

func parseImageCount(value any) int {
	switch v := value.(type) {
	case float64:
		if v >= 1 {
			return int(v)
		}
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil && parsed >= 1 {
			return parsed
		}
	}
	return 1
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clientIP(r *http.Request) string {
	for _, header := range []string{"CF-Connecting-IP", "X-Real-IP"} {
		if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
			return value
		}
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func buildUpstreamURL(base *url.URL, input *url.URL) *url.URL {
	out := *base
	path := input.EscapedPath()
	path = strings.TrimPrefix(path, "/api-proxy")
	path = strings.TrimPrefix(path, "/image/api-proxy")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	basePath := strings.TrimRight(base.EscapedPath(), "/")
	if basePath != "" && basePath != "." {
		out.Path = basePath + path
	} else {
		out.Path = path
	}
	out.RawQuery = input.RawQuery
	out.ForceQuery = input.ForceQuery
	return &out
}

func isLimitedFreeRequest(r *http.Request) bool {
	mode := strings.EqualFold(strings.TrimSpace(r.Header.Get(limitedFreeHeader)), limitedFreeValue)
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	bearer := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer"))
	return mode || bearer == limitedFreeSentinel
}

func copyRequestHeaders(dst, src http.Header) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if _, blocked := hopByHopHeaders[canonical]; blocked {
			continue
		}
		dst.Del(canonical)
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if _, blocked := hopByHopHeaders[canonical]; blocked {
			continue
		}
		dst.Del(canonical)
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func setForwardedHeaders(outReq *http.Request, inReq *http.Request) {
	if host, _, err := net.SplitHostPort(inReq.RemoteAddr); err == nil && host != "" {
		prior := outReq.Header.Get("X-Forwarded-For")
		if prior != "" {
			outReq.Header.Set("X-Forwarded-For", prior+", "+host)
		} else {
			outReq.Header.Set("X-Forwarded-For", host)
		}
	}
	outReq.Header.Set("X-Forwarded-Proto", schemeFromRequest(inReq))
	outReq.Header.Set("X-Forwarded-Host", inReq.Host)
}

func schemeFromRequest(r *http.Request) string {
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		return proto
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func writeProxyError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message}})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func sanitizePath(u *url.URL) string {
	if u == nil {
		return ""
	}
	return u.EscapedPath()
}
