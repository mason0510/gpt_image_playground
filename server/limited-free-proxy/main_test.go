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
		UpstreamBase:        upstreamURL,
		LimitedFreeKey:      "test-free-key",
		LimitedFreeDailyMax: 8,
		RateLimitSalt:       "test-salt",
		RateLimitStorePath:  filepath.Join(t.TempDir(), "usage.json"),
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
		UpstreamBase:        upstreamURL,
		LimitedFreeKey:      "test-free-key",
		LimitedFreeDailyMax: 1,
		RateLimitSalt:       "test-salt",
		RateLimitStorePath:  filepath.Join(t.TempDir(), "usage.json"),
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
		records:   map[string]usageRecord{},
		dailyMax:  1,
		salt:      "test-salt",
		storePath: filepath.Join(t.TempDir(), "usage.json"),
		now:       func() time.Time { return time.Date(2026, 6, 10, 10, 0, 0, 0, time.Local) },
	}
	req := limitedFreeJSONRequest(t, `{}`)
	if !limiter.Reserve(req, 1).Allowed {
		t.Fatal("first day first request should be allowed")
	}
	if limiter.Reserve(req, 1).Allowed {
		t.Fatal("first day second request should be rejected")
	}
	limiter.now = func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.Local) }
	if !limiter.Reserve(req, 1).Allowed {
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
		UpstreamBase:        upstreamURL,
		LimitedFreeKey:      "real-free-key",
		LimitedFreeDailyMax: 10,
		RateLimitSalt:       "test-salt",
		RateLimitStorePath:  filepath.Join(t.TempDir(), "usage.json"),
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
		UpstreamBase:        upstreamURL,
		LimitedFreeKey:      "real-free-key",
		LimitedFreeDailyMax: 10,
		RateLimitSalt:       "test-salt",
		RateLimitStorePath:  filepath.Join(t.TempDir(), "usage.json"),
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
	if upstreamHits != 1 {
		t.Fatalf("only models request should reach upstream, upstreamHits=%d", upstreamHits)
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
		UpstreamBase:        upstreamURL,
		LimitedFreeKey:      "test-free-key",
		LimitedFreeDailyMax: 1,
		RateLimitSalt:       "test-salt",
		RateLimitStorePath:  filepath.Join(t.TempDir(), "usage.json"),
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

func TestLimitedFreeEmptySuccessBodyDoesNotConsumeDailyQuota(t *testing.T) {
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
		UpstreamBase:        upstreamURL,
		LimitedFreeKey:      "test-free-key",
		LimitedFreeDailyMax: 1,
		RateLimitSalt:       "test-salt",
		RateLimitStorePath:  filepath.Join(t.TempDir(), "usage.json"),
	})

	emptyResp := httptest.NewRecorder()
	handler.ServeHTTP(emptyResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if emptyResp.Code != http.StatusBadGateway {
		t.Fatalf("empty upstream status=%d body=%s", emptyResp.Code, emptyResp.Body.String())
	}
	var emptyPayload map[string]map[string]any
	if err := json.Unmarshal(emptyResp.Body.Bytes(), &emptyPayload); err != nil {
		t.Fatal(err)
	}
	if emptyPayload["error"]["code"] != "empty_upstream_body" {
		t.Fatalf("unexpected empty payload: %v", emptyPayload)
	}

	successResp := httptest.NewRecorder()
	handler.ServeHTTP(successResp, limitedFreeJSONRequest(t, `{"n":1}`))
	if successResp.Code != http.StatusOK {
		t.Fatalf("success after empty response should still be allowed, status=%d body=%s", successResp.Code, successResp.Body.String())
	}
}
