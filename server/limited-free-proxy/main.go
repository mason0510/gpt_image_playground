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
	"mime"
	"mime/multipart"
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
	defaultDaily4KLimit = 5
	maxImagesPerRequest = 4
	fourKPixelThreshold = 6_000_000
	maxImageRetryCount  = 5
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
	ListenAddr            string
	UpstreamBase          *url.URL
	LimitedFreeKey        string
	LimitedFreeDailyMax   int
	LimitedFreeDaily4KMax int
	RateLimitSalt         string
	RateLimitStorePath    string
}

type usageRecord struct {
	Day     string `json:"day"`
	Count   int    `json:"count"`
	Count4K int    `json:"count_4k,omitempty"`
}

type usageSnapshot struct {
	Day         string `json:"day"`
	Limit       int    `json:"limit"`
	Used        int    `json:"used"`
	Remaining   int    `json:"remaining"`
	Limit4K     int    `json:"limit_4k"`
	Used4K      int    `json:"used_4k"`
	Remaining4K int    `json:"remaining_4k"`
}

type freeUsageLimiter struct {
	mu         sync.Mutex
	records    map[string]usageRecord
	dailyMax   int
	daily4KMax int
	salt       string
	storePath  string
	now        func() time.Time
}

type usageCost struct {
	Total int
	FourK int
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
	daily4KMax := defaultDaily4KLimit
	if raw := strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_LIMITED_FREE_DAILY_4K_MAX")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			return config{}, fmt.Errorf("IMAGINATION_SPACE_LIMITED_FREE_DAILY_4K_MAX 必须是正整数")
		}
		daily4KMax = parsed
	}

	return config{
		ListenAddr:            listenAddr,
		UpstreamBase:          upstream,
		LimitedFreeKey:        strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_LIMITED_FREE_API_KEY")),
		LimitedFreeDailyMax:   dailyMax,
		LimitedFreeDaily4KMax: daily4KMax,
		RateLimitSalt:         strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_RATE_LIMIT_SALT")),
		RateLimitStorePath:    strings.TrimSpace(os.Getenv("IMAGINATION_SPACE_RATE_LIMIT_STORE_PATH")),
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
		if limitedFree && isLimitedFreeQuotaRequest(r) {
			snapshot := limiter.Snapshot(r)
			writeJSON(w, http.StatusOK, map[string]any{
				"mode":      limitedFreeValue,
				"quota":     snapshot,
				"timestamp": time.Now().Format(time.RFC3339),
			})
			return
		}
		var limitedFreeReservation *quotaReservation
		limitedFreeChargeable := false
		defer func() {
			if limitedFreeReservation != nil && !limitedFreeChargeable {
				limitedFreeReservation.Rollback()
			}
		}()
		if limitedFree {
			if cfg.LimitedFreeKey == "" {
				writeProxyError(w, http.StatusServiceUnavailable, "限时免费 key 暂不可用，请填写自己的 API Key")
				return
			}
			cost, body, err := readLimitedFreeRouteCost(r)
			if err != nil {
				var routeErr limitedFreeRouteError
				if errors.As(err, &routeErr) {
					writeJSON(w, http.StatusForbidden, map[string]any{
						"error": map[string]any{
							"message": "限时免费 key 仅支持图片生成/编辑相关接口，请切换为自己的 API Key 后使用其他接口。",
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
			if cost.Total > 0 {
				if cost.Total > maxImagesPerRequest {
					w.Header().Set("X-Imagination-Space-Free-Max-Per-Request", strconv.Itoa(maxImagesPerRequest))
					writeJSON(w, http.StatusBadRequest, map[string]any{
						"error": map[string]any{
							"message":   fmt.Sprintf("限时免费 key 单次最多生成 %d 张图，请降低数量后重试。", maxImagesPerRequest),
							"type":      "invalid_request_error",
							"code":      "free_request_image_limit",
							"limit":     maxImagesPerRequest,
							"requested": cost.Total,
						},
					})
					return
				}
				result := limiter.Reserve(r, cost)
				if !result.Allowed {
					if cost.FourK > 0 && result.Remaining4K == 0 {
						writeJSON(w, http.StatusTooManyRequests, map[string]any{
							"error": map[string]any{
								"message": "限时免费 key 的 4K 图片今日免费体验额度已用完（每天最多 5 张）。请明天再试，或切换为自己的 API Key。",
								"type":    "rate_limit_exceeded",
								"code":    "free_daily_4k_limit",
							},
						})
						return
					}
					writeJSON(w, http.StatusTooManyRequests, map[string]any{
						"error": map[string]any{
							"message": "限时免费 key 今日免费体验额度已用完。请明天再试，或切换为自己的 API Key。",
							"type":    "rate_limit_exceeded",
							"code":    "free_daily_limit",
						},
					})
					return
				}
				limitedFreeReservation = result.Reservation
			}
		}

		requestBodyForForward, imageLog := captureImageRequestLog(r)
		promptLog := imageLog.Prompt
		if promptLog != "" {
			log.Printf("image_request_prompt trace_id=%s method=%s path=%s content_type=%q prompt=%q", clientTraceID(r), r.Method, sanitizePath(r.URL), r.Header.Get("Content-Type"), promptLog)
		}
		if imageLog.HasParams {
			log.Printf(
				"image_request_params trace_id=%s method=%s path=%s content_type=%q model=%q size=%q n=%d requested_4k=%t",
				clientTraceID(r),
				r.Method,
				sanitizePath(r.URL),
				r.Header.Get("Content-Type"),
				imageLog.Model,
				imageLog.Size,
				imageLog.N,
				is4KSize(imageLog.Size),
			)
		}

		upstreamURL := buildUpstreamURL(cfg.UpstreamBase, r.URL)
		outReq, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL.String(), requestBodyForForward)
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

		resp, respBody, err := doUpstreamRequestWithRetry(client, outReq)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(r.Context().Err(), context.Canceled) {
				return
			}
			log.Printf("upstream_error method=%s path=%s err=%v", r.Method, sanitizePath(r.URL), err)
			writeProxyError(w, http.StatusBadGateway, "上游代理请求失败")
			return
		}
		if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices && len(bytes.TrimSpace(respBody)) == 0 {
			log.Printf("empty_upstream_body method=%s path=%s upstream_status=%d content_type=%q", r.Method, sanitizePath(r.URL), resp.StatusCode, resp.Header.Get("Content-Type"))
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": map[string]any{
					"message": fmt.Sprintf("上游返回空响应体（upstream_status=%d, content_type=%q）", resp.StatusCode, resp.Header.Get("Content-Type")),
					"type":    "upstream_error",
					"code":    "empty_upstream_body",
				},
			})
			return
		}

		if limitedFreeReservation != nil && isChargeableLimitedFreeResponse(resp.StatusCode, resp.Header, respBody) {
			limitedFreeChargeable = true
		}

		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		if _, err := w.Write(respBody); err != nil {
			log.Printf("copy_response_error method=%s path=%s err=%v", r.Method, sanitizePath(r.URL), err)
		}
	})
}

func doUpstreamRequestWithRetry(client *http.Client, req *http.Request) (*http.Response, []byte, error) {
	if client == nil || req == nil {
		return nil, nil, fmt.Errorf("invalid upstream request")
	}
	attempts := 1
	if shouldRetryImageRequest(req) {
		attempts = maxImageRetryCount
	}
	var lastResp *http.Response
	var lastBody []byte
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		clonedReq, err := cloneRequestForRetry(req)
		if err != nil {
			return nil, nil, err
		}
		resp, body, err := doSingleUpstreamRequest(client, clonedReq)
		if err == nil && !shouldRetryUpstreamResponse(clonedReq, resp, body) {
			return resp, body, nil
		}
		if resp != nil && err == nil {
			lastResp = resp
			lastBody = body
			lastErr = nil
			log.Printf("image_upstream_retry attempt=%d/%d method=%s path=%s status=%d", attempt, attempts, clonedReq.Method, sanitizePath(clonedReq.URL), resp.StatusCode)
		} else if err != nil {
			lastErr = err
			log.Printf("image_upstream_retry attempt=%d/%d method=%s path=%s err=%v", attempt, attempts, clonedReq.Method, sanitizePath(clonedReq.URL), err)
			if errors.Is(err, context.Canceled) || errors.Is(clonedReq.Context().Err(), context.Canceled) {
				return nil, nil, err
			}
		}
		if attempt == attempts {
			break
		}
		time.Sleep(imageRetryBackoff(attempt))
	}
	if lastResp != nil {
		return lastResp, lastBody, nil
	}
	return nil, nil, lastErr
}

func doSingleUpstreamRequest(client *http.Client, req *http.Request) (*http.Response, []byte, error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	body, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if readErr != nil {
		return nil, nil, readErr
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, body, nil
}

func cloneRequestForRetry(req *http.Request) (*http.Request, error) {
	cloned := req.Clone(req.Context())
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		cloned.Body = body
		return cloned, nil
	}
	if req.Body == nil {
		return cloned, nil
	}
	data, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(data))
	cloned.Body = io.NopCloser(bytes.NewReader(data))
	cloned.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	}
	cloned.ContentLength = int64(len(data))
	req.GetBody = cloned.GetBody
	req.ContentLength = cloned.ContentLength
	return cloned, nil
}

func shouldRetryImageRequest(req *http.Request) bool {
	if req == nil || req.URL == nil {
		return false
	}
	if req.Method != http.MethodPost {
		return false
	}
	return strings.Contains(req.URL.EscapedPath(), "/images/")
}

func shouldRetryUpstreamResponse(req *http.Request, resp *http.Response, body []byte) bool {
	if !shouldRetryImageRequest(req) || resp == nil {
		return false
	}
	if resp.StatusCode == http.StatusBadGateway || resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusGatewayTimeout {
		return true
	}
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices && len(bytes.TrimSpace(body)) == 0 {
		return true
	}
	return false
}

func imageRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	return time.Duration(attempt) * 200 * time.Millisecond
}

type allowResult struct {
	Allowed     bool
	Limit       int
	Used        int
	Remaining   int
	Limit4K     int
	Used4K      int
	Remaining4K int
	Reservation *quotaReservation
}

type quotaReservation struct {
	limiter *freeUsageLimiter
	key     string
	day     string
	delta   int
	delta4K int
	once    sync.Once
}

func newFreeUsageLimiter(cfg config) *freeUsageLimiter {
	limiter := &freeUsageLimiter{
		records:    map[string]usageRecord{},
		dailyMax:   cfg.LimitedFreeDailyMax,
		daily4KMax: cfg.LimitedFreeDaily4KMax,
		salt:       cfg.RateLimitSalt,
		storePath:  cfg.RateLimitStorePath,
		now:        time.Now,
	}
	if limiter.dailyMax < 1 {
		limiter.dailyMax = defaultDailyLimit
	}
	if limiter.daily4KMax < 1 {
		limiter.daily4KMax = defaultDaily4KLimit
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

func (l *freeUsageLimiter) Reserve(r *http.Request, cost usageCost) allowResult {
	if cost.Total < 1 {
		cost.Total = 1
	}
	if cost.FourK < 0 {
		cost.FourK = 0
	}
	if cost.FourK > cost.Total {
		cost.FourK = cost.Total
	}
	today := l.now().In(time.Local).Format("2006-01-02")
	key := l.deviceKey(r, today)

	l.mu.Lock()
	defer l.mu.Unlock()

	record := l.records[key]
	if record.Day != today {
		record = usageRecord{Day: today}
	}
	if record.Count+cost.Total > l.dailyMax || record.Count4K+cost.FourK > l.daily4KMax {
		return allowResult{
			Allowed:     false,
			Limit:       l.dailyMax,
			Used:        record.Count,
			Remaining:   maxInt(0, l.dailyMax-record.Count),
			Limit4K:     l.daily4KMax,
			Used4K:      record.Count4K,
			Remaining4K: maxInt(0, l.daily4KMax-record.Count4K),
		}
	}
	record.Count += cost.Total
	record.Count4K += cost.FourK
	l.records[key] = record
	l.saveLocked()
	return allowResult{
		Allowed:     true,
		Limit:       l.dailyMax,
		Used:        record.Count,
		Remaining:   maxInt(0, l.dailyMax-record.Count),
		Limit4K:     l.daily4KMax,
		Used4K:      record.Count4K,
		Remaining4K: maxInt(0, l.daily4KMax-record.Count4K),
		Reservation: &quotaReservation{limiter: l, key: key, day: today, delta: cost.Total, delta4K: cost.FourK},
	}
}

func (l *freeUsageLimiter) Snapshot(r *http.Request) usageSnapshot {
	today := l.now().In(time.Local).Format("2006-01-02")
	key := l.deviceKey(r, today)

	l.mu.Lock()
	defer l.mu.Unlock()

	record := l.records[key]
	if record.Day != today {
		record = usageRecord{Day: today}
	}
	return usageSnapshot{
		Day:         today,
		Limit:       l.dailyMax,
		Used:        record.Count,
		Remaining:   maxInt(0, l.dailyMax-record.Count),
		Limit4K:     l.daily4KMax,
		Used4K:      record.Count4K,
		Remaining4K: maxInt(0, l.daily4KMax-record.Count4K),
	}
}

func (r *quotaReservation) Rollback() {
	if r == nil || r.limiter == nil {
		return
	}
	r.once.Do(func() {
		l := r.limiter
		l.mu.Lock()
		defer l.mu.Unlock()

		record := l.records[r.key]
		if record.Day != r.day {
			return
		}
		record.Count = maxInt(0, record.Count-r.delta)
		record.Count4K = maxInt(0, record.Count4K-r.delta4K)
		if record.Count == 0 && record.Count4K == 0 {
			delete(l.records, r.key)
		} else {
			l.records[r.key] = record
		}
		l.saveLocked()
	})
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

func readLimitedFreeRouteCost(r *http.Request) (usageCost, []byte, error) {
	path := r.URL.EscapedPath()
	if r.Method == http.MethodGet && strings.HasSuffix(path, "/v1/limited-free/quota") {
		return usageCost{}, nil, nil
	}
	if r.Method == http.MethodGet && (strings.HasSuffix(path, "/v1/models") || strings.HasSuffix(path, "/models")) {
		return usageCost{}, nil, nil
	}
	if r.Method != http.MethodPost || !strings.Contains(path, "/images/") {
		return usageCost{}, nil, limitedFreeRouteError{}
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return usageCost{}, nil, err
	}
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.Contains(contentType, "multipart/form-data") {
		return parseMultipartImageCost(body, contentType), body, nil
	}
	if contentType != "" && !strings.Contains(contentType, "json") {
		return usageCost{Total: 1}, body, nil
	}
	var payload struct {
		N    any    `json:"n"`
		Size string `json:"size"`
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			return usageCost{}, body, err
		}
	}
	total := parseImageCount(payload.N)
	fourK := 0
	if is4KSize(payload.Size) {
		fourK = total
	}
	return usageCost{Total: total, FourK: fourK}, body, nil
}

func parseMultipartImageCost(body []byte, contentType string) usageCost {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return usageCost{Total: 1}
	}
	boundary := strings.TrimSpace(params["boundary"])
	if boundary == "" {
		return usageCost{Total: 1}
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	total := 1
	size := ""
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			fourK := 0
			if is4KSize(size) {
				fourK = total
			}
			return usageCost{Total: total, FourK: fourK}
		}
		if err != nil {
			return usageCost{Total: 1}
		}
		name := part.FormName()
		if name != "n" && name != "size" {
			_, _ = io.Copy(io.Discard, part)
			_ = part.Close()
			continue
		}
		data, err := io.ReadAll(io.LimitReader(part, 64))
		_ = part.Close()
		if err != nil {
			return usageCost{Total: 1}
		}
		if name == "n" {
			total = parseImageCount(string(data))
			continue
		}
		size = string(data)
	}
}

func is4KSize(raw string) bool {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return false
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == 'x' || r == '×' || r == 'X'
	})
	if len(parts) != 2 {
		return false
	}
	width, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || width < 1 {
		return false
	}
	height, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || height < 1 {
		return false
	}
	return width*height >= fourKPixelThreshold
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

func isChargeableLimitedFreeResponse(status int, headers http.Header, body []byte) bool {
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return false
	}
	contentType := strings.ToLower(headers.Get("Content-Type"))
	if contentType != "" && !strings.Contains(contentType, "json") {
		return len(body) > 0
	}
	var payload struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	return len(payload.Data) > 0
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

func isLimitedFreeQuotaRequest(r *http.Request) bool {
	if r == nil || r.Method != http.MethodGet {
		return false
	}
	path := r.URL.EscapedPath()
	return strings.HasSuffix(path, "/v1/limited-free/quota")
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

type imageRequestLog struct {
	Prompt    string
	Model     string
	Size      string
	N         int
	HasParams bool
}

func capturePromptLog(r *http.Request) (io.Reader, string) {
	reader, imageLog := captureImageRequestLog(r)
	return reader, imageLog.Prompt
}

func captureImageRequestLog(r *http.Request) (io.Reader, imageRequestLog) {
	if r == nil || r.Body == nil || r.Method != http.MethodPost || !strings.Contains(r.URL.EscapedPath(), "/images/") {
		if r != nil {
			return r.Body, imageRequestLog{}
		}
		return nil, imageRequestLog{}
	}

	contentType := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if strings.Contains(contentType, "json") {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return r.Body, imageRequestLog{}
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		return bytes.NewReader(body), extractJSONImageRequestLog(body)
	}

	if strings.Contains(contentType, "multipart/form-data") {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return r.Body, imageRequestLog{}
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		return bytes.NewReader(body), extractMultipartImageRequestLog(body, contentType)
	}

	return r.Body, imageRequestLog{}
}

func extractJSONPrompt(body []byte) string {
	return extractJSONImageRequestLog(body).Prompt
}

func extractJSONImageRequestLog(body []byte) imageRequestLog {
	var payload map[string]any
	if len(bytes.TrimSpace(body)) == 0 {
		return imageRequestLog{}
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return imageRequestLog{}
	}
	logFields := imageRequestLog{N: 1}
	if prompt, ok := payload["prompt"].(string); ok {
		logFields.Prompt = normalizePromptLogValue(prompt)
	} else if input, ok := payload["input"].(string); ok {
		logFields.Prompt = normalizePromptLogValue(input)
	}
	if model, ok := payload["model"].(string); ok {
		logFields.Model = strings.TrimSpace(model)
	}
	if size, ok := payload["size"].(string); ok {
		logFields.Size = strings.TrimSpace(size)
	}
	logFields.N = parseImageCount(payload["n"])
	logFields.HasParams = logFields.Model != "" || logFields.Size != "" || payload["n"] != nil
	return logFields
}

func extractMultipartPrompt(body []byte, contentType string) string {
	return extractMultipartImageRequestLog(body, contentType).Prompt
}

func extractMultipartImageRequestLog(body []byte, contentType string) imageRequestLog {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return imageRequestLog{}
	}
	boundary := strings.TrimSpace(params["boundary"])
	if boundary == "" {
		return imageRequestLog{}
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	logFields := imageRequestLog{N: 1}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			logFields.HasParams = logFields.Model != "" || logFields.Size != ""
			return logFields
		}
		if err != nil {
			return imageRequestLog{}
		}
		name := part.FormName()
		if name != "prompt" && name != "model" && name != "size" && name != "n" {
			_, _ = io.Copy(io.Discard, part)
			_ = part.Close()
			continue
		}
		data, err := io.ReadAll(io.LimitReader(part, 8192))
		_ = part.Close()
		if err != nil {
			return imageRequestLog{}
		}
		value := strings.TrimSpace(string(data))
		switch name {
		case "prompt":
			logFields.Prompt = normalizePromptLogValue(value)
		case "model":
			logFields.Model = value
		case "size":
			logFields.Size = value
		case "n":
			logFields.N = parseImageCount(value)
			logFields.HasParams = true
		}
	}
}

func normalizePromptLogValue(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return ""
	}
	prompt = strings.ReplaceAll(prompt, "\r", " ")
	prompt = strings.ReplaceAll(prompt, "\n", " ")
	prompt = strings.Join(strings.Fields(prompt), " ")
	const maxPromptLogLen = 500
	if len(prompt) > maxPromptLogLen {
		return prompt[:maxPromptLogLen] + "...(truncated)"
	}
	return prompt
}

func clientTraceID(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(r.Header.Get("X-Client-Trace-Id"))
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
