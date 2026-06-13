package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

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
		w.WriteHeader(http.StatusOK)
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
	if !limiter.Allow(req, 1).Allowed {
		t.Fatal("first day first request should be allowed")
	}
	if limiter.Allow(req, 1).Allowed {
		t.Fatal("first day second request should be rejected")
	}
	limiter.now = func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.Local) }
	if !limiter.Allow(req, 1).Allowed {
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
