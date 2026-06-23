package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func TestLimitedFreeImageRequestRetriesUpToFiveTimesOn502(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		if upstreamHits < 5 {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": map[string]any{"message": "temporary upstream failure"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": "ok"}},
		})
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "test-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, limitedFreeJSONRequest(t, `{"n":1}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("retry request status=%d body=%s", resp.Code, resp.Body.String())
	}
	if upstreamHits != 5 {
		t.Fatalf("expected 5 upstream attempts, got %d", upstreamHits)
	}
}

func TestCapturePromptLogFromJSONBody(t *testing.T) {
	rawBody := "{\"prompt\":\"\\n  生成 一张 海报  \\n第二行\\n\",\"n\":1}"
	req := httptest.NewRequest(http.MethodPost, "/api-proxy/v1/images/generations", bytes.NewBufferString(rawBody))
	req.Header.Set("Content-Type", "application/json")

	reader, prompt := capturePromptLog(req)
	if prompt != "生成 一张 海报 第二行" {
		t.Fatalf("unexpected prompt=%q", prompt)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != rawBody {
		t.Fatalf("forward body mismatch: %s", string(body))
	}
}

func TestCapturePromptLogFromMultipartBody(t *testing.T) {
	buf := &bytes.Buffer{}
	writer := multipart.NewWriter(buf)
	if err := writer.WriteField("model", "gpt-image-2"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", "\n  海报 主标题  \n第二行\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api-proxy/v1/images/edits", bytes.NewReader(buf.Bytes()))
	req.Header.Set("Content-Type", writer.FormDataContentType())

	reader, prompt := capturePromptLog(req)
	if prompt != "海报 主标题 第二行" {
		t.Fatalf("unexpected prompt=%q", prompt)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, buf.Bytes()) {
		t.Fatal("forward multipart body mismatch")
	}
}

func TestLimitedFreeDailyLimitCountsImagesNAndRejectsOverflow(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

	cfg := config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "test-free-key",
		LimitedFreeDailyMax:   8,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	}
	handler := newProxyHandler(cfg)

	for i := 0; i < 2; i++ {
		req := limitedFreeJSONRequest(t, `{"n":4}`)
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("request %d status=%d body=%s", i+1, resp.Code, resp.Body.String())
		}
	}

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, limitedFreeJSONRequest(t, `{"n":1}`))
	if resp.Code != http.StatusTooManyRequests {
		t.Fatalf("overflow status=%d body=%s", resp.Code, resp.Body.String())
	}
	if upstreamHits != 2 {
		t.Fatalf("overflow request should not reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestCustomKeyBypassesLimitedFreeLimit(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "test-free-key",
		LimitedFreeDailyMax:   1,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api-proxy/v1/images/generations", bytes.NewBufferString(`{"n":10}`))
		req.Header.Set("Authorization", "Bearer custom-key")
		req.Header.Set("Content-Type", "application/json")
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("custom request %d status=%d", i+1, resp.Code)
		}
	}
	if upstreamHits != 3 {
		t.Fatalf("custom requests should all reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestLimitedFreeResetsAcrossDays(t *testing.T) {
	limiter := &freeUsageLimiter{
		records:    map[string]usageRecord{},
		dailyMax:   1,
		daily4KMax: 5,
		salt:       "test-salt",
		storePath:  filepath.Join(t.TempDir(), "usage.json"),
		now:        func() time.Time { return time.Date(2026, 6, 10, 10, 0, 0, 0, time.Local) },
	}
	req := limitedFreeJSONRequest(t, `{}`)
	if !limiter.Reserve(req, usageCost{Total: 1}).Allowed {
		t.Fatal("first day first request should be allowed")
	}
	if limiter.Reserve(req, usageCost{Total: 1}).Allowed {
		t.Fatal("first day second request should be rejected")
	}
	limiter.now = func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.Local) }
	if !limiter.Reserve(req, usageCost{Total: 1}).Allowed {
		t.Fatal("next day request should be allowed")
	}
}

func TestLimitedFreeRejectsTooManyImagesPerRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request over per-request limit should not be forwarded upstream")
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, limitedFreeJSONRequest(t, `{"n":5}`))

	if resp.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", resp.Code, resp.Body.String())
	}
	if got := resp.Header().Get("X-Imagination-Space-Free-Max-Per-Request"); got != "4" {
		t.Fatalf("expected max per request header 4, got %q", got)
	}
	var payload map[string]map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["error"]["code"] != "free_request_image_limit" {
		t.Fatalf("unexpected error payload: %v", payload)
	}
}

func TestLimitedFreeAllowsModelsButRejectsNonImageEndpoints(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": r.URL.Path})
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	modelsReq := httptest.NewRequest(http.MethodGet, "/api-proxy/v1/models", nil)
	modelsReq.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	modelsResp := httptest.NewRecorder()
	handler.ServeHTTP(modelsResp, modelsReq)
	if modelsResp.Code != http.StatusOK {
		t.Fatalf("models should be allowed, got %d body=%s", modelsResp.Code, modelsResp.Body.String())
	}

	chatReq := httptest.NewRequest(http.MethodPost, "/api-proxy/v1/chat/completions", bytes.NewBufferString(`{"model":"x","messages":[]}`))
	chatReq.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	chatReq.Header.Set("Content-Type", "application/json")
	chatResp := httptest.NewRecorder()
	handler.ServeHTTP(chatResp, chatReq)
	if chatResp.Code != http.StatusForbidden {
		t.Fatalf("chat should be rejected, got %d body=%s", chatResp.Code, chatResp.Body.String())
	}
	var payload map[string]map[string]any
	if err := json.Unmarshal(chatResp.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["error"]["code"] != "limited_free_endpoint_not_allowed" {
		t.Fatalf("unexpected error payload: %v", payload)
	}
	if payload["error"]["message"] != "限时免费 key 仅支持图片生成/编辑相关接口，请切换为自己的 API Key 后使用其他接口。" {
		t.Fatalf("unexpected error message: %v", payload)
	}
	if upstreamHits != 1 {
		t.Fatalf("only models request should reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestLimitedFreeQuotaEndpointReturnsUsageWithoutTouchingUpstream(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	firstResp := httptest.NewRecorder()
	handler.ServeHTTP(firstResp, limitedFreeJSONRequest(t, `{"n":3}`))
	if firstResp.Code != http.StatusOK {
		t.Fatalf("seed request status=%d body=%s", firstResp.Code, firstResp.Body.String())
	}

	quotaReq := httptest.NewRequest(http.MethodGet, "/api-proxy/v1/limited-free/quota", nil)
	quotaReq.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	quotaReq.Header.Set(limitedFreeHeader, limitedFreeValue)
	quotaReq.Header.Set(deviceHeader, "device-a")
	quotaReq.Header.Set("User-Agent", "test-agent")
	quotaReq.Header.Set("Accept-Language", "zh-CN")
	quotaReq.RemoteAddr = "203.0.113.10:12345"

	quotaResp := httptest.NewRecorder()
	handler.ServeHTTP(quotaResp, quotaReq)
	if quotaResp.Code != http.StatusOK {
		t.Fatalf("quota status=%d body=%s", quotaResp.Code, quotaResp.Body.String())
	}

	var payload struct {
		Mode  string `json:"mode"`
		Quota struct {
			Limit       int `json:"limit"`
			Used        int `json:"used"`
			Remaining   int `json:"remaining"`
			Limit4K     int `json:"limit_4k"`
			Used4K      int `json:"used_4k"`
			Remaining4K int `json:"remaining_4k"`
		} `json:"quota"`
	}
	if err := json.Unmarshal(quotaResp.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Mode != limitedFreeValue {
		t.Fatalf("unexpected mode=%q", payload.Mode)
	}
	if payload.Quota.Used != 3 || payload.Quota.Remaining != 7 || payload.Quota.Limit != 10 {
		t.Fatalf("unexpected quota payload=%+v", payload.Quota)
	}
	if payload.Quota.Used4K != 0 || payload.Quota.Remaining4K != 5 || payload.Quota.Limit4K != 5 {
		t.Fatalf("unexpected 4k quota payload=%+v", payload.Quota)
	}
	if upstreamHits != 1 {
		t.Fatalf("quota endpoint should not hit upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestLimitedFreeMultipartEditCountsNAgainstDailyLimit(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"b64_json": "ok"}}})
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   3,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	firstResp := httptest.NewRecorder()
	handler.ServeHTTP(firstResp, limitedFreeMultipartEditRequest(t, "2"))
	if firstResp.Code != http.StatusOK {
		t.Fatalf("first edit status=%d body=%s", firstResp.Code, firstResp.Body.String())
	}

	secondResp := httptest.NewRecorder()
	handler.ServeHTTP(secondResp, limitedFreeMultipartEditRequest(t, "2"))
	if secondResp.Code != http.StatusTooManyRequests {
		t.Fatalf("second edit should overflow daily limit, got %d body=%s", secondResp.Code, secondResp.Body.String())
	}
	if upstreamHits != 1 {
		t.Fatalf("overflow multipart edit should not reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestLimitedFree4KDailyLimitRejectsSixth4KImage(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	for i := 0; i < 5; i++ {
		resp := httptest.NewRecorder()
		handler.ServeHTTP(resp, limitedFreeJSONRequest(t, `{"n":1,"size":"2304x3456"}`))
		if resp.Code != http.StatusOK {
			t.Fatalf("seed 4k request %d status=%d body=%s", i+1, resp.Code, resp.Body.String())
		}
	}

	overflow := httptest.NewRecorder()
	handler.ServeHTTP(overflow, limitedFreeJSONRequest(t, `{"n":1,"size":"2304x3456"}`))
	if overflow.Code != http.StatusTooManyRequests {
		t.Fatalf("sixth 4k request should be rejected, got %d body=%s", overflow.Code, overflow.Body.String())
	}
	var payload map[string]map[string]any
	if err := json.Unmarshal(overflow.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["error"]["code"] != "free_daily_4k_limit" {
		t.Fatalf("unexpected 4k error payload: %v", payload)
	}
	if upstreamHits != 5 {
		t.Fatalf("overflow 4k request should not reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestLimitedFreeQuotaTracks4KUsage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, limitedFreeJSONRequest(t, `{"n":2,"size":"3840x2160"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("4k request status=%d body=%s", resp.Code, resp.Body.String())
	}

	quotaReq := httptest.NewRequest(http.MethodGet, "/api-proxy/v1/limited-free/quota", nil)
	quotaReq.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	quotaReq.Header.Set(limitedFreeHeader, limitedFreeValue)
	quotaReq.Header.Set(deviceHeader, "device-a")
	quotaReq.Header.Set("User-Agent", "test-agent")
	quotaReq.Header.Set("Accept-Language", "zh-CN")
	quotaReq.RemoteAddr = "203.0.113.10:12345"
	quotaResp := httptest.NewRecorder()
	handler.ServeHTTP(quotaResp, quotaReq)
	if quotaResp.Code != http.StatusOK {
		t.Fatalf("quota status=%d body=%s", quotaResp.Code, quotaResp.Body.String())
	}

	var payload struct {
		Quota struct {
			Used        int `json:"used"`
			Remaining   int `json:"remaining"`
			Used4K      int `json:"used_4k"`
			Remaining4K int `json:"remaining_4k"`
			Limit4K     int `json:"limit_4k"`
		} `json:"quota"`
	}
	if err := json.Unmarshal(quotaResp.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Quota.Used != 2 || payload.Quota.Remaining != 8 || payload.Quota.Used4K != 2 || payload.Quota.Remaining4K != 3 || payload.Quota.Limit4K != 5 {
		t.Fatalf("unexpected quota payload=%+v", payload.Quota)
	}
}

func TestLimitedFreeMultipart4KEditCountsAgainst4KLimit(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"b64_json": "ok"}}})
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "real-free-key",
		LimitedFreeDailyMax:   10,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, limitedFreeMultipartEditRequestWithSize(t, "3", "2304x3456"))
	if first.Code != http.StatusOK {
		t.Fatalf("first 4k edit status=%d body=%s", first.Code, first.Body.String())
	}

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, limitedFreeMultipartEditRequestWithSize(t, "3", "2304x3456"))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second 4k edit should overflow 4k daily limit, got %d body=%s", second.Code, second.Body.String())
	}
	if upstreamHits != 1 {
		t.Fatalf("overflow multipart 4k edit should not reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func limitedFreeJSONRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api-proxy/v1/images/generations", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	req.Header.Set(limitedFreeHeader, limitedFreeValue)
	req.Header.Set(deviceHeader, "device-a")
	req.Header.Set("User-Agent", "test-agent")
	req.Header.Set("Accept-Language", "zh-CN")
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.10:12345"
	return req
}

func limitedFreeMultipartEditRequest(t *testing.T, n string) *http.Request {
	return limitedFreeMultipartEditRequestWithSize(t, n, "")
}

func limitedFreeMultipartEditRequestWithSize(t *testing.T, n string, size string) *http.Request {
	t.Helper()
	buf := &bytes.Buffer{}
	writer := multipart.NewWriter(buf)
	if err := writer.WriteField("model", "gpt-image-2"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", "把猫改成橘色"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("n", n); err != nil {
		t.Fatal(err)
	}
	if size != "" {
		if err := writer.WriteField("size", size); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("image", "original.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("fake-png")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api-proxy/v1/images/edits", bytes.NewReader(buf.Bytes()))
	req.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	req.Header.Set(limitedFreeHeader, limitedFreeValue)
	req.Header.Set(deviceHeader, "device-a")
	req.Header.Set("User-Agent", "test-agent")
	req.Header.Set("Accept-Language", "zh-CN")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.RemoteAddr = "203.0.113.10:12345"
	return req
}

func TestLimitedFreeFailedUpstreamDoesNotConsumeDailyQuota(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		if upstreamHits == 1 {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]any{"message": "upstream failed"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"b64_json": "ok"}}})
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "test-free-key",
		LimitedFreeDailyMax:   1,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	failedResp := httptest.NewRecorder()
	handler.ServeHTTP(failedResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if failedResp.Code != http.StatusInternalServerError {
		t.Fatalf("failed upstream status=%d body=%s", failedResp.Code, failedResp.Body.String())
	}

	successResp := httptest.NewRecorder()
	handler.ServeHTTP(successResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if successResp.Code != http.StatusOK {
		t.Fatalf("success after failed request should still be allowed, status=%d body=%s", successResp.Code, successResp.Body.String())
	}

	overflowResp := httptest.NewRecorder()
	handler.ServeHTTP(overflowResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if overflowResp.Code != http.StatusTooManyRequests {
		t.Fatalf("successful request should consume quota; overflow status=%d body=%s", overflowResp.Code, overflowResp.Body.String())
	}
	if upstreamHits != 2 {
		t.Fatalf("overflow should not reach upstream, upstreamHits=%d", upstreamHits)
	}
}

func TestLimitedFreeEmptySuccessBodyRetriesAndStillConsumesQuotaOnce(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		if upstreamHits == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"b64_json": "ok"}}})
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

	handler := newProxyHandler(config{
		UpstreamBase:          upstreamURL,
		LimitedFreeKey:        "test-free-key",
		LimitedFreeDailyMax:   1,
		LimitedFreeDaily4KMax: 5,
		RateLimitSalt:         "test-salt",
		RateLimitStorePath:    filepath.Join(t.TempDir(), "usage.json"),
	})

	retryResp := httptest.NewRecorder()
	handler.ServeHTTP(retryResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if retryResp.Code != http.StatusOK {
		t.Fatalf("empty-body retry status=%d body=%s", retryResp.Code, retryResp.Body.String())
	}
	if upstreamHits != 2 {
		t.Fatalf("expected retry after empty success body, upstreamHits=%d", upstreamHits)
	}

	overflowResp := httptest.NewRecorder()
	handler.ServeHTTP(overflowResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if overflowResp.Code != http.StatusTooManyRequests {
		t.Fatalf("successful retried request should consume quota once; overflow status=%d body=%s", overflowResp.Code, overflowResp.Body.String())
	}
}
