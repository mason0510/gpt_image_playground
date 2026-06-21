package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBaseURL          = "https://space.tap365.org/api-proxy"
	defaultModel            = "gpt-image-2"
	defaultOutputDir        = "./output/space-cli"
	limitedFreeSentinel     = "__IMAGINATION_SPACE_LIMITED_FREE_KEY__"
	limitedFreeHeader       = "X-Imagination-Space-Key-Mode"
	limitedFreeValue        = "limited-free"
	deviceFingerprintHeader = "X-Imagination-Space-Device-Fingerprint"
	defaultAcceptLanguage   = "zh-CN,zh;q=0.9"
)

type imageResponse struct {
	Created int64 `json:"created"`
	Data    []struct {
		B64JSON       string `json:"b64_json"`
		URL           string `json:"url"`
		RevisedPrompt string `json:"revised_prompt"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

type commonOptions struct {
	BaseURL           string
	APIKey            string
	DeviceFingerprint string
	UserAgent         string
	AcceptLanguage    string
	TimeoutSeconds    int
	PrintCurl         bool
}

func main() {
	if len(os.Args) < 2 {
		printUsage(os.Stderr)
		os.Exit(2)
	}

	switch os.Args[1] {
	case "quota":
		if err := runQuota(os.Args[2:]); err != nil {
			fail(err)
		}
	case "models":
		if err := runModels(os.Args[2:]); err != nil {
			fail(err)
		}
	case "generate":
		if err := runGenerate(os.Args[2:]); err != nil {
			fail(err)
		}
	case "edit":
		if err := runEdit(os.Args[2:]); err != nil {
			fail(err)
		}
	case "-h", "--help", "help":
		printUsage(os.Stdout)
	default:
		fail(fmt.Errorf("未知子命令: %s", os.Args[1]))
	}
}

func runQuota(args []string) error {
	fs := flag.NewFlagSet("quota", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	optsRef := bindCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	opts := *optsRef
	if strings.TrimSpace(opts.APIKey) != "" {
		return fmt.Errorf("quota 子命令只适用于 limited-free；请不要传 --api-key")
	}
	if opts.PrintCurl {
		fmt.Println(buildCurlCommand(http.MethodGet, joinURL(opts.BaseURL, "/v1/limited-free/quota"), opts, nil, nil))
		return nil
	}

	respBody, status, err := doJSONRequest(http.MethodGet, joinURL(opts.BaseURL, "/v1/limited-free/quota"), nil, opts)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		if status == http.StatusForbidden && bytes.Contains(respBody, []byte(`"limited_free_endpoint_not_allowed"`)) {
			return fmt.Errorf("quota 请求失败: 当前线上尚未开放 GET /v1/limited-free/quota；请继续用 models/generate/edit，body=%s", string(respBody))
		}
		return fmt.Errorf("quota 请求失败: status=%d body=%s", status, string(respBody))
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, respBody, "", "  "); err == nil {
		fmt.Println(pretty.String())
		return nil
	}
	fmt.Println(string(respBody))
	return nil
}

func runModels(args []string) error {
	fs := flag.NewFlagSet("models", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	optsRef := bindCommonFlags(fs)
	idsOnly := fs.Bool("ids-only", false, "只输出模型 id，每行一个")
	if err := fs.Parse(args); err != nil {
		return err
	}
	opts := *optsRef
	if opts.PrintCurl {
		fmt.Println(buildCurlCommand(http.MethodGet, joinURL(opts.BaseURL, "/v1/models"), opts, nil, nil))
		return nil
	}

	respBody, status, err := doJSONRequest(http.MethodGet, joinURL(opts.BaseURL, "/v1/models"), nil, opts)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("models 请求失败: status=%d body=%s", status, string(respBody))
	}
	if *idsOnly {
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(respBody, &payload); err != nil {
			return fmt.Errorf("models 响应解析失败: %w body=%s", err, string(respBody))
		}
		for _, item := range payload.Data {
			if strings.TrimSpace(item.ID) != "" {
				fmt.Println(item.ID)
			}
		}
		return nil
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, respBody, "", "  "); err == nil {
		fmt.Println(pretty.String())
		return nil
	}
	fmt.Println(string(respBody))
	return nil
}

func runGenerate(args []string) error {
	fs := flag.NewFlagSet("generate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	optsRef := bindCommonFlags(fs)

	prompt := fs.String("prompt", "", "提示词")
	model := fs.String("model", defaultModel, "模型名")
	size := fs.String("size", "1024x1024", "尺寸")
	quality := fs.String("quality", "standard", "质量")
	outputFormat := fs.String("output-format", "png", "输出格式: png|jpeg|webp")
	outputCompression := fs.Int("output-compression", -1, "压缩质量 0-100，仅 jpeg/webp 常用")
	moderation := fs.String("moderation", "", "审核级别，可留空")
	n := fs.Int("n", 1, "生成数量")
	outDir := fs.String("out-dir", defaultOutputDir, "输出目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	opts := *optsRef
	if strings.TrimSpace(*prompt) == "" {
		return fmt.Errorf("缺少 --prompt")
	}
	if *n < 1 {
		return fmt.Errorf("--n 必须 >= 1")
	}

	body := map[string]any{
		"model":         strings.TrimSpace(*model),
		"prompt":        strings.TrimSpace(*prompt),
		"size":          strings.TrimSpace(*size),
		"quality":       strings.TrimSpace(*quality),
		"output_format": strings.TrimSpace(*outputFormat),
		"n":             *n,
	}
	if *outputCompression >= 0 {
		body["output_compression"] = *outputCompression
	}
	if v := strings.TrimSpace(*moderation); v != "" {
		body["moderation"] = v
	}
	if opts.PrintCurl {
		fmt.Println(buildCurlCommand(http.MethodPost, joinURL(opts.BaseURL, "/v1/images/generations"), opts, body, nil))
		return nil
	}

	respBody, status, err := doJSONRequest(http.MethodPost, joinURL(opts.BaseURL, "/v1/images/generations"), body, opts)
	if err != nil {
		return err
	}
	return saveImageResponse(respBody, status, *outDir, normalizedExt(*outputFormat), opts)
}

func runEdit(args []string) error {
	fs := flag.NewFlagSet("edit", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	optsRef := bindCommonFlags(fs)

	prompt := fs.String("prompt", "", "编辑提示词")
	model := fs.String("model", defaultModel, "模型名")
	imagePath := fs.String("image", "", "原图路径")
	maskPath := fs.String("mask", "", "遮罩路径，可选")
	size := fs.String("size", "1024x1024", "尺寸")
	n := fs.Int("n", 1, "生成数量")
	outDir := fs.String("out-dir", defaultOutputDir, "输出目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	opts := *optsRef
	if strings.TrimSpace(*prompt) == "" {
		return fmt.Errorf("缺少 --prompt")
	}
	if strings.TrimSpace(*imagePath) == "" {
		return fmt.Errorf("缺少 --image")
	}
	if *n < 1 {
		return fmt.Errorf("--n 必须 >= 1")
	}
	if opts.PrintCurl {
		fmt.Println(buildCurlCommand(http.MethodPost, joinURL(opts.BaseURL, "/v1/images/edits"), opts, nil, []curlFormField{
			{Name: "model", Value: strings.TrimSpace(*model)},
			{Name: "prompt", Value: strings.TrimSpace(*prompt)},
			{Name: "size", Value: strings.TrimSpace(*size)},
			{Name: "n", Value: strconv.Itoa(*n)},
			{Name: "image", FilePath: strings.TrimSpace(*imagePath), IsFile: true},
			{Name: "mask", FilePath: strings.TrimSpace(*maskPath), IsFile: strings.TrimSpace(*maskPath) != ""},
		}))
		return nil
	}

	respBody, status, err := doMultipartEditRequest(joinURL(opts.BaseURL, "/v1/images/edits"), *prompt, *model, *size, *imagePath, *maskPath, *n, opts)
	if err != nil {
		return err
	}
	return saveImageResponse(respBody, status, *outDir, "png", opts)
}

func bindCommonFlags(fs *flag.FlagSet) *commonOptions {
	opts := &commonOptions{}
	defaultUA := defaultUserAgent()
	defaultFP := defaultDeviceFingerprint()
	fs.StringVar(&opts.BaseURL, "base-url", defaultBaseURL, "接口基址，默认直打 space.tap365.org 同源代理")
	fs.StringVar(&opts.APIKey, "api-key", "", "自定义 API Key；留空时默认走 limited-free")
	fs.StringVar(&opts.DeviceFingerprint, "device-fingerprint", defaultFP, "设备指纹；limited-free 模式建议保持稳定")
	fs.StringVar(&opts.UserAgent, "user-agent", defaultUA, "User-Agent")
	fs.StringVar(&opts.AcceptLanguage, "accept-language", defaultAcceptLanguage, "Accept-Language")
	fs.IntVar(&opts.TimeoutSeconds, "timeout", 180, "请求超时秒数")
	fs.BoolVar(&opts.PrintCurl, "print-curl", false, "只打印等价 curl，不实际发请求")
	return opts
}

func doJSONRequest(method, rawURL string, body any, opts commonOptions) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, rawURL, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	applyCommonHeaders(req, opts)
	return doRequest(req, opts)
}

func doMultipartEditRequest(rawURL, prompt, model, size, imagePath, maskPath string, n int, opts commonOptions) ([]byte, int, error) {
	buf := &bytes.Buffer{}
	writer := multipart.NewWriter(buf)
	if err := writer.WriteField("model", strings.TrimSpace(model)); err != nil {
		return nil, 0, err
	}
	if err := writer.WriteField("prompt", strings.TrimSpace(prompt)); err != nil {
		return nil, 0, err
	}
	if err := writer.WriteField("size", strings.TrimSpace(size)); err != nil {
		return nil, 0, err
	}
	if err := writer.WriteField("n", strconv.Itoa(n)); err != nil {
		return nil, 0, err
	}
	if err := addFormFile(writer, "image", imagePath); err != nil {
		return nil, 0, err
	}
	if strings.TrimSpace(maskPath) != "" {
		if err := addFormFile(writer, "mask", maskPath); err != nil {
			return nil, 0, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, 0, err
	}

	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(buf.Bytes()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	applyCommonHeaders(req, opts)
	return doRequest(req, opts)
}

func addFormFile(writer *multipart.Writer, fieldName, filePath string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	part, err := writer.CreateFormFile(fieldName, filepath.Base(filePath))
	if err != nil {
		return err
	}
	_, err = io.Copy(part, f)
	return err
}

func doRequest(req *http.Request, opts commonOptions) ([]byte, int, error) {
	client := &http.Client{Timeout: time.Duration(opts.TimeoutSeconds) * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func applyCommonHeaders(req *http.Request, opts commonOptions) {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", opts.AcceptLanguage)
	req.Header.Set("User-Agent", opts.UserAgent)
	req.Header.Set("X-Client-Trace-Id", buildTraceID())

	if strings.TrimSpace(opts.APIKey) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(opts.APIKey))
		return
	}

	req.Header.Set("Authorization", "Bearer "+limitedFreeSentinel)
	req.Header.Set(limitedFreeHeader, limitedFreeValue)
	req.Header.Set(deviceFingerprintHeader, strings.TrimSpace(opts.DeviceFingerprint))
}

func saveImageResponse(respBody []byte, status int, outDir, defaultExt string, opts commonOptions) error {
	if status < 200 || status >= 300 {
		return fmt.Errorf("生图请求失败: status=%d body=%s", status, string(respBody))
	}
	var payload imageResponse
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return fmt.Errorf("响应不是合法 JSON: %w body=%s", err, string(respBody))
	}
	if payload.Error != nil {
		return fmt.Errorf("接口返回错误: code=%s type=%s message=%s", payload.Error.Code, payload.Error.Type, payload.Error.Message)
	}
	if len(payload.Data) == 0 {
		return fmt.Errorf("接口成功但未返回图片数据")
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}

	saved := make([]string, 0, len(payload.Data))
	for i, item := range payload.Data {
		var filePath string
		if strings.TrimSpace(item.B64JSON) != "" {
			decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(item.B64JSON))
			if err != nil {
				return fmt.Errorf("解码 b64_json 失败: %w", err)
			}
			filePath = filepath.Join(outDir, buildImageFileName(i+1, defaultExt))
			if err := os.WriteFile(filePath, decoded, 0o644); err != nil {
				return err
			}
		} else if strings.TrimSpace(item.URL) != "" {
			path, err := downloadImage(item.URL, outDir, i+1, defaultExt, opts)
			if err != nil {
				return err
			}
			filePath = path
		} else {
			return fmt.Errorf("第 %d 张图片既没有 b64_json 也没有 url", i+1)
		}
		saved = append(saved, filePath)
		if strings.TrimSpace(item.RevisedPrompt) != "" {
			fmt.Printf("revised_prompt[%d]: %s\n", i+1, item.RevisedPrompt)
		}
	}

	fmt.Printf("status: ok, images=%d\n", len(saved))
	for _, path := range saved {
		fmt.Printf("saved: %s\n", path)
	}
	if strings.TrimSpace(opts.APIKey) == "" {
		fmt.Println("mode: limited-free")
		fmt.Println("note: 仍受每天 10 张、其中 4K 最多 5 张、单次最多 4 张、文生图/改图合计限制。")
	}
	return nil
}

func downloadImage(rawURL, outDir string, index int, defaultExt string, opts commonOptions) (string, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", opts.UserAgent)
	client := &http.Client{Timeout: time.Duration(opts.TimeoutSeconds) * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("下载图片失败: status=%d body=%s", resp.StatusCode, string(body))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	ext := extFromContentType(resp.Header.Get("Content-Type"))
	if ext == "" {
		ext = extFromURLPath(rawURL)
	}
	if ext == "" {
		ext = defaultExt
	}
	path := filepath.Join(outDir, buildImageFileName(index, ext))
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func buildImageFileName(index int, ext string) string {
	ext = normalizedExt(ext)
	return fmt.Sprintf("space-cli-%s-%02d.%s", time.Now().Format("20060102-150405"), index, ext)
}

func buildTraceID() string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d", time.Now().UnixNano())))
	return "imgcli_" + time.Now().Format("20060102150405") + "_" + hex.EncodeToString(sum[:3])
}

func defaultUserAgent() string {
	return "imagination-space-cli/0.1"
}

func defaultDeviceFingerprint() string {
	hostname, _ := os.Hostname()
	user := strings.TrimSpace(os.Getenv("USER"))
	if user == "" {
		user = strings.TrimSpace(os.Getenv("USERNAME"))
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{"space-cli", hostname, user}, "\n")))
	return "cli-" + hex.EncodeToString(sum[:8])
}

func joinURL(base, path string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	path = "/" + strings.TrimLeft(strings.TrimSpace(path), "/")
	return base + path
}

type curlFormField struct {
	Name     string
	Value    string
	FilePath string
	IsFile   bool
}

func buildCurlCommand(method, rawURL string, opts commonOptions, jsonBody any, formFields []curlFormField) string {
	parts := []string{"curl", "-sS", "-X", shellQuote(strings.ToUpper(strings.TrimSpace(method))), shellQuote(rawURL)}
	parts = append(parts, "-H", shellQuote("Accept: application/json"))
	parts = append(parts, "-H", shellQuote("Accept-Language: "+opts.AcceptLanguage))
	parts = append(parts, "-H", shellQuote("User-Agent: "+opts.UserAgent))
	if strings.TrimSpace(opts.APIKey) != "" {
		parts = append(parts, "-H", shellQuote("Authorization: Bearer "+strings.TrimSpace(opts.APIKey)))
	} else {
		parts = append(parts, "-H", shellQuote("Authorization: Bearer "+limitedFreeSentinel))
		parts = append(parts, "-H", shellQuote(limitedFreeHeader+": "+limitedFreeValue))
		parts = append(parts, "-H", shellQuote(deviceFingerprintHeader+": "+strings.TrimSpace(opts.DeviceFingerprint)))
	}
	if jsonBody != nil {
		body, err := json.Marshal(jsonBody)
		if err == nil {
			parts = append(parts, "-H", shellQuote("Content-Type: application/json"))
			parts = append(parts, "--data", shellQuote(string(body)))
		}
	}
	for _, field := range formFields {
		if field.IsFile {
			if strings.TrimSpace(field.FilePath) == "" {
				continue
			}
			parts = append(parts, "-F", shellQuote(field.Name+"=@"+field.FilePath))
			continue
		}
		parts = append(parts, "-F", shellQuote(field.Name+"="+field.Value))
	}
	return strings.Join(parts, " ")
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func normalizedExt(ext string) string {
	ext = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(ext), "."))
	switch ext {
	case "jpg":
		return "jpeg"
	case "":
		return "png"
	default:
		return ext
	}
}

func extFromContentType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	switch strings.ToLower(mediaType) {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpeg"
	case "image/webp":
		return "webp"
	default:
		return ""
	}
}

func extFromURLPath(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(parsed.Path)), ".")
	return normalizedExt(ext)
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "错误: %v\n\n", err)
	printUsage(os.Stderr)
	os.Exit(1)
}

func printUsage(w io.Writer) {
	_, _ = fmt.Fprintln(w, `space-cli：本地直连 Space API 的最小 CLI。

默认行为：
- 默认走 https://space.tap365.org/api-proxy
- 不传 --api-key 时，自动走 limited-free 免费额度
- 无需网页登录

用法：
  space-cli quota
  space-cli models
  space-cli generate --prompt "一只坐在窗边的猫"
  space-cli edit --image ./input.png --prompt "把背景改成雪山"

常用示例：
  space-cli quota
  space-cli models --ids-only
  space-cli models --print-curl
  space-cli generate --prompt "赛博朋克城市夜景" --n 1 --size 1024x1024
  space-cli generate --prompt "电商海报" --print-curl
  space-cli edit --image ./cat.png --prompt "把猫改成橘色" --n 1
  space-cli edit --image ./cat.png --prompt "把猫改成橘色" --print-curl
  space-cli generate --api-key sk-xxx --prompt "自定义 key 生图"

说明：
- limited-free 模式仍受每天 10 张、其中 4K 最多 5 张、单次最多 4 张、文生图/改图合计限制。
- 若要与某个固定设备指纹保持一致，可手动传 --device-fingerprint。
- --print-curl 只打印等价后端请求，便于对照 web / api-proxy 调用。`)
}
