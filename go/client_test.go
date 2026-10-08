package ausca

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type doerFunc func(*http.Request) (*http.Response, error)

func (fn doerFunc) Do(request *http.Request) (*http.Response, error) { return fn(request) }

const testCatalog = `{"offers":[{"offer_id":"browser.session","title":"Browser session","description":"Browser","revision":"r1","revision_digest":"sha256:revision","input_schema":{"digest":"sha256:input","public_path":"/input.json"},"output_schema":{"digest":"sha256:output","public_path":"/output.json"},"route":{"method":"POST","path":"/v1/lease-browser"},"price":{"currency":"USD","model":"input_choice","minimum_minor":5,"maximum_minor":20,"policy_digest":"sha256:price"}}]}`

func testServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/catalog.json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, testCatalog)
			return
		}
		handler(w, r)
	}))
}

func TestInvokePreservesPurchaseAcrossPaymentRetry(t *testing.T) {
	var seen [][]byte
	server := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/lease-browser" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		seen = append(seen, body)
		if r.Header.Get("PAYMENT-SIGNATURE") == "" {
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = io.WriteString(w, `{"accepts":[]}`)
			return
		}
		_, _ = io.WriteString(w, `{"status":"succeeded","receipt_ref":{"public_url":"https://runx.ai/r/test"}}`)
	})
	defer server.Close()
	payer := doerFunc(func(request *http.Request) (*http.Response, error) {
		first, err := http.DefaultClient.Do(request)
		if err != nil || first.StatusCode != http.StatusPaymentRequired {
			return first, err
		}
		_ = first.Body.Close()
		body, err := request.GetBody()
		if err != nil {
			return nil, err
		}
		retry := request.Clone(request.Context())
		retry.Body = body
		retry.Header.Set("PAYMENT-SIGNATURE", "test-signature")
		return http.DefaultClient.Do(retry)
	})
	client := NewClientForOrigin(server.URL, http.DefaultClient, payer)
	var retained Identity
	result, err := client.Invoke(context.Background(), "browser.session", map[string]any{"duration_seconds": 600}, InvokeOptions{
		IdempotencyKey: "purchase-browser-0001",
		BeforePayment:  func(identity Identity) error { retained = identity; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if retained != result.Identity || result.Status != 200 || len(seen) != 2 || !bytes.Equal(seen[0], seen[1]) {
		t.Fatalf("identity/body changed across payment retry: %#v %#v", retained, result)
	}
	var body map[string]any
	if err := json.Unmarshal(seen[0], &body); err != nil {
		t.Fatal(err)
	}
	if body["idempotency_key"] != retained.IdempotencyKey || body["offer_revision_digest"] != "sha256:revision" {
		t.Fatalf("invalid bound envelope: %#v", body)
	}
}

func TestProbeNeverUsesPaymentAuthority(t *testing.T) {
	server := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
	})
	defer server.Close()
	client := NewClientForOrigin(server.URL, http.DefaultClient, doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("probe used payment authority")
		return nil, nil
	}))
	response, identity, err := client.Probe(context.Background(), "browser.session", map[string]any{"duration_seconds": 600}, InvokeOptions{IdempotencyKey: "purchase-browser-0001"})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 402 || identity.IdempotencyKey != "purchase-browser-0001" {
		t.Fatalf("unexpected probe: %d %#v", response.StatusCode, identity)
	}
}

func TestInvokeUncertainAndRefusalKeepIdentity(t *testing.T) {
	server := testServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"code":"replay_conflict"}`)
	})
	defer server.Close()
	identity := Identity{OfferID: "browser.session", IdempotencyKey: "purchase-browser-0001"}
	client := NewClientForOrigin(server.URL, http.DefaultClient, doerFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection closed after send")
	}))
	_, err := client.Invoke(context.Background(), identity.OfferID, map[string]any{}, InvokeOptions{IdempotencyKey: identity.IdempotencyKey})
	var uncertain *UncertainError
	if !errors.As(err, &uncertain) || uncertain.Identity != identity {
		t.Fatalf("lost uncertain purchase identity: %v", err)
	}
	client.payment = http.DefaultClient
	_, err = client.Invoke(context.Background(), identity.OfferID, map[string]any{}, InvokeOptions{IdempotencyKey: identity.IdempotencyKey})
	var refusal *RefusalError
	if !errors.As(err, &refusal) || refusal.Identity != identity || refusal.Status != 409 || !strings.Contains(string(refusal.Body), "replay_conflict") {
		t.Fatalf("lost typed refusal: %v", err)
	}
}

func TestBeforePaymentFailureDoesNotCallAuthority(t *testing.T) {
	server := testServer(t, func(http.ResponseWriter, *http.Request) { t.Fatal("unexpected paid request") })
	defer server.Close()
	client := NewClientForOrigin(server.URL, http.DefaultClient, doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("payment authority called after failed identity persistence")
		return nil, nil
	}))
	_, err := client.Invoke(context.Background(), "browser.session", nil, InvokeOptions{BeforePayment: func(Identity) error {
		return errors.New("disk unavailable")
	}})
	if err == nil || err.Error() != "disk unavailable" {
		t.Fatalf("wrong prepayment error: %v", err)
	}
}

func TestArtifactCommitAndBodylessAccess(t *testing.T) {
	const data = "test bytes"
	server := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/artifacts":
			var request struct {
				DataBase64    string `json:"data_base64"`
				ContentDigest string `json:"content_digest"`
				MediaType     string `json:"media_type"`
				Key           string `json:"idempotency_key"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if request.DataBase64 != "dGVzdCBieXRlcw==" || request.Key != "artifact-upload-0001" {
				t.Fatalf("wrong artifact upload: %#v", request)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "stored", "artifact": map[string]any{
				"artifact_ref": "art_1", "content_digest": request.ContentDigest, "media_type": request.MediaType,
				"size_bytes": len(data), "created_at": "now",
			}})
		case "/v1/artifacts/art_1/access":
			body, _ := io.ReadAll(r.Body)
			if len(body) != 0 || r.Header.Get("Idempotency-Key") != "artifact-access-0001" {
				t.Fatalf("access request carried body or lost key: %s %#v", body, r.Header)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ready", "artifact": map[string]any{
				"artifact_ref": "art_1", "content_digest": "sha256:test", "media_type": "text/plain",
				"size_bytes": len(data), "created_at": "now", "download_url": "https://example.com/download", "expires_at": "later",
			}})
		default:
			t.Fatalf("unexpected route %s", r.URL.Path)
		}
	})
	defer server.Close()
	client := NewClientForOrigin(server.URL, http.DefaultClient, nil)
	commitment, err := client.Commit(context.Background(), []byte(data), "text/plain", "artifact-upload-0001")
	if err != nil || commitment.ArtifactRef != "art_1" {
		t.Fatalf("commit: %#v %v", commitment, err)
	}
	access, err := client.Access(context.Background(), commitment.ArtifactRef, "artifact-access-0001")
	if err != nil || access.DownloadURL == "" {
		t.Fatalf("access: %#v %v", access, err)
	}
}

func TestInvalidCatalogRouteIsRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, strings.Replace(testCatalog, "/v1/lease-browser", "//another-host/path", 1))
	}))
	defer server.Close()
	client := NewClientForOrigin(server.URL, http.DefaultClient, nil)
	if _, err := client.Catalog(context.Background()); err == nil {
		t.Fatal("accepted a route outside the service origin")
	}
}

func TestCatalogCallerCannotMutateCache(t *testing.T) {
	server := testServer(t, func(http.ResponseWriter, *http.Request) {})
	defer server.Close()
	client := NewClientForOrigin(server.URL, http.DefaultClient, nil)
	offers, err := client.Catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	offers[0].Route.Path = "//evil.example/path"
	again, err := client.Offer(context.Background(), "browser.session")
	if err != nil || again.Route.Path != "/v1/lease-browser" {
		t.Fatalf("catalog cache was mutable: %#v %v", again, err)
	}
}

func TestLiveCatalog(t *testing.T) {
	if os.Getenv("AUSCA_LIVE_TEST") != "1" {
		t.Skip("set AUSCA_LIVE_TEST=1 for public, read-only catalog proof")
	}
	client := NewClient(nil)
	offers, err := client.Catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(offers) == 0 {
		t.Fatal("live catalog is empty")
	}
	for _, offer := range offers {
		if _, _, err := client.Envelope(offer, map[string]any{}, InvokeOptions{}); err != nil {
			t.Fatalf("offer %s cannot be bound: %v", offer.OfferID, err)
		}
	}
}
