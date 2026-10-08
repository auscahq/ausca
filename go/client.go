// Package ausca is a small, rail-neutral buyer client for Ausca's live catalog.
// A payment-capable HTTP client owns challenge handling, signing, and spend policy.
package ausca

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"
)

const Origin = "https://ausca.com"
const maxResponseBytes = 8 << 20

// HTTPDoer is the payment authority port. Pass a client that handles HTTP 402
// challenges under a caller-selected spend policy. Read-only requests bypass it.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type Client struct {
	origin  string
	reader  HTTPDoer
	payment HTTPDoer
	mu      sync.RWMutex
	offers  []Offer
}

// NewClient uses the public Ausca origin. payment may be nil for discovery and
// challenge inspection, but Invoke then refuses before any request is sent.
func NewClient(payment HTTPDoer) *Client {
	return NewClientForOrigin(Origin, http.DefaultClient, payment)
}

// NewClientForOrigin permits a custom origin and read transport, including
// local test servers. The payment transport never receives catalog reads.
func NewClientForOrigin(origin string, reader, payment HTTPDoer) *Client {
	if reader == nil {
		reader = http.DefaultClient
	}
	return &Client{origin: strings.TrimRight(origin, "/"), reader: reader, payment: payment}
}

type PriceOption struct {
	AmountMinor int64           `json:"amount_minor"`
	Value       json.RawMessage `json:"value"`
}

type Price struct {
	Currency     string        `json:"currency"`
	Model        string        `json:"model"`
	MinimumMinor int64         `json:"minimum_minor"`
	MaximumMinor int64         `json:"maximum_minor"`
	InputField   string        `json:"input_field,omitempty"`
	Options      []PriceOption `json:"options,omitempty"`
	PolicyDigest string        `json:"policy_digest"`
}

type Offer struct {
	OfferID        string `json:"offer_id"`
	Title          string `json:"title"`
	Description    string `json:"description"`
	Revision       string `json:"revision"`
	RevisionDigest string `json:"revision_digest"`
	InputSchema    struct {
		Digest     string `json:"digest"`
		PublicPath string `json:"public_path"`
	} `json:"input_schema"`
	OutputSchema struct {
		Digest     string `json:"digest"`
		PublicPath string `json:"public_path"`
	} `json:"output_schema"`
	Route struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	} `json:"route"`
	Price Price `json:"price"`
}

// Identity must be retained before payment and reused with identical input
// when an outcome is uncertain. A new key means a new intentional purchase.
type Identity struct {
	OfferID        string
	IdempotencyKey string
}

type Attribution struct {
	Source   string `json:"source"`
	Campaign string `json:"campaign,omitempty"`
}

type InvokeOptions struct {
	IdempotencyKey string
	Attribution    *Attribution
	// BeforePayment must durably retain identity before the paid HTTP request.
	// Its error aborts the call without contacting the payment authority.
	BeforePayment func(Identity) error
}

type Result struct {
	Status   int
	Body     json.RawMessage
	Identity Identity
}

type RefusalError struct {
	Status   int
	Body     json.RawMessage
	Identity Identity
}

func (e *RefusalError) Error() string {
	return fmt.Sprintf("ausca resource answered %d; inspect the body and retain purchase key %s", e.Status, e.Identity.IdempotencyKey)
}

type UncertainError struct {
	Identity Identity
	Cause    error
}

func (e *UncertainError) Error() string {
	return fmt.Sprintf("ausca outcome uncertain; recover %s with the same input and key %s", e.Identity.OfferID, e.Identity.IdempotencyKey)
}

func (e *UncertainError) Unwrap() error { return e.Cause }

func (c *Client) Catalog(ctx context.Context) ([]Offer, error) {
	c.mu.RLock()
	if c.offers != nil {
		cached := cloneOffers(c.offers)
		c.mu.RUnlock()
		return cached, nil
	}
	c.mu.RUnlock()
	return c.RefreshCatalog(ctx)
}

func (c *Client) RefreshCatalog(ctx context.Context) ([]Offer, error) {
	response, err := c.request(ctx, c.reader, http.MethodGet, "/catalog.json", nil, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog answered %d", response.StatusCode)
	}
	var document struct {
		Offers []Offer `json:"offers"`
	}
	if err := decodeJSON(response.Body, &document); err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	if document.Offers == nil {
		return nil, errors.New("catalog has no offers")
	}
	for _, offer := range document.Offers {
		if err := validateOffer(offer); err != nil {
			return nil, err
		}
	}
	c.mu.Lock()
	c.offers = document.Offers
	c.mu.Unlock()
	return cloneOffers(document.Offers), nil
}

func (c *Client) Offer(ctx context.Context, offerID string) (Offer, error) {
	offers, err := c.Catalog(ctx)
	if err != nil {
		return Offer{}, err
	}
	for _, offer := range offers {
		if offer.OfferID == offerID {
			return offer, nil
		}
	}
	return Offer{}, fmt.Errorf("offer %q is not active in the catalog", offerID)
}

func (c *Client) Price(ctx context.Context, offerID string) (Price, error) {
	offer, err := c.Offer(ctx, offerID)
	return offer.Price, err
}

func (c *Client) Envelope(offer Offer, input any, options InvokeOptions) ([]byte, Identity, error) {
	if err := validateOffer(offer); err != nil {
		return nil, Identity{}, err
	}
	key := options.IdempotencyKey
	if key == "" {
		var err error
		key, err = newKey("ausca-")
		if err != nil {
			return nil, Identity{}, err
		}
	}
	if err := validateKey(key); err != nil {
		return nil, Identity{}, err
	}
	if options.Attribution != nil && !validAttribution(*options.Attribution) {
		return nil, Identity{}, errors.New("attribution source and campaign must be bounded lowercase labels")
	}
	identity := Identity{OfferID: offer.OfferID, IdempotencyKey: key}
	body, err := json.Marshal(struct {
		OfferID             string       `json:"offer_id"`
		OfferRevision       string       `json:"offer_revision"`
		OfferRevisionDigest string       `json:"offer_revision_digest"`
		InputSchemaDigest   string       `json:"input_schema_digest"`
		OutputSchemaDigest  string       `json:"output_schema_digest"`
		Input               any          `json:"input"`
		IdempotencyKey      string       `json:"idempotency_key"`
		Attribution         *Attribution `json:"attribution,omitempty"`
	}{offer.OfferID, offer.Revision, offer.RevisionDigest, offer.InputSchema.Digest, offer.OutputSchema.Digest, input, key, options.Attribution})
	return body, identity, err
}

// Probe sends the exact invocation envelope without the payment authority.
// Its 402 response is inspectable and does not authorize a purchase.
func (c *Client) Probe(ctx context.Context, offerID string, input any, options InvokeOptions) (*http.Response, Identity, error) {
	offer, err := c.Offer(ctx, offerID)
	if err != nil {
		return nil, Identity{}, err
	}
	body, identity, err := c.Envelope(offer, input, options)
	if err != nil {
		return nil, Identity{}, err
	}
	response, err := c.request(ctx, c.reader, http.MethodPost, offer.Route.Path, body, nil)
	return response, identity, err
}

// Invoke pays within the authority's policy. On any transport uncertainty,
// reuse the returned identity with the same input; never mint a new key.
func (c *Client) Invoke(ctx context.Context, offerID string, input any, options InvokeOptions) (Result, error) {
	if c.payment == nil {
		return Result{}, errors.New("payment authority is required for Invoke")
	}
	offer, err := c.Offer(ctx, offerID)
	if err != nil {
		return Result{}, err
	}
	body, identity, err := c.Envelope(offer, input, options)
	if err != nil {
		return Result{}, err
	}
	if options.BeforePayment != nil {
		if err := options.BeforePayment(identity); err != nil {
			return Result{}, err
		}
	}
	response, err := c.request(ctx, c.payment, http.MethodPost, offer.Route.Path, body, nil)
	if err != nil {
		return Result{}, &UncertainError{Identity: identity, Cause: err}
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body)
	if err != nil {
		return Result{}, &UncertainError{Identity: identity, Cause: err}
	}
	result := Result{Status: response.StatusCode, Body: data, Identity: identity}
	if response.StatusCode >= 400 {
		return result, &RefusalError{Status: response.StatusCode, Body: data, Identity: identity}
	}
	if !json.Valid(data) {
		return Result{}, &UncertainError{Identity: identity, Cause: errors.New("invalid JSON response")}
	}
	return result, nil
}

// Invocation is a read-only state lookup; it cannot start another purchase.
func (c *Client) Invocation(ctx context.Context, invocationID string) (json.RawMessage, error) {
	if invocationID == "" {
		return nil, errors.New("invocation ID is required")
	}
	response, err := c.request(ctx, c.reader, http.MethodGet, "/v1/invocations/"+url.PathEscape(invocationID), nil, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK || !json.Valid(data) {
		return nil, fmt.Errorf("invocation read answered %d", response.StatusCode)
	}
	return data, nil
}

func (c *Client) request(ctx context.Context, doer HTTPDoer, method, path string, body []byte, headers http.Header) (*http.Response, error) {
	if doer == nil {
		return nil, errors.New("HTTP transport is required")
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return nil, errors.New("invalid resource path")
	}
	request, err := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	return doer.Do(request)
}

func validateOffer(offer Offer) error {
	if offer.OfferID == "" || offer.Revision == "" || offer.RevisionDigest == "" ||
		offer.InputSchema.Digest == "" || offer.OutputSchema.Digest == "" ||
		offer.Route.Method != http.MethodPost || !strings.HasPrefix(offer.Route.Path, "/v1/") ||
		strings.Contains(offer.Route.Path, "..") || strings.ContainsAny(offer.Route.Path, "?#") || strings.HasPrefix(offer.Route.Path, "//") {
		return fmt.Errorf("invalid catalog binding for offer %q", offer.OfferID)
	}
	return nil
}

func validateKey(key string) error {
	if len(key) < 16 || len(key) > 128 || !utf8.ValidString(key) || strings.TrimSpace(key) != key {
		return errors.New("idempotency key must be 16 to 128 clean UTF-8 bytes")
	}
	for _, char := range key {
		if char < 32 || char == 127 {
			return errors.New("idempotency key must be 16 to 128 clean UTF-8 bytes")
		}
	}
	return nil
}

func validAttribution(value Attribution) bool {
	return validLabel(value.Source, 64) && (value.Campaign == "" || validLabel(value.Campaign, 128))
}

func validLabel(value string, max int) bool {
	if value == "" || len(value) > max || !asciiAlnum(rune(value[0])) {
		return false
	}
	for _, char := range value {
		if asciiAlnum(char) || char == '.' || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func asciiAlnum(char rune) bool {
	return char >= 'a' && char <= 'z' || char >= '0' && char <= '9'
}

func cloneOffers(offers []Offer) []Offer {
	copyOf := append([]Offer(nil), offers...)
	for index := range copyOf {
		copyOf[index].Price.Options = append([]PriceOption(nil), offers[index].Price.Options...)
		for option := range copyOf[index].Price.Options {
			copyOf[index].Price.Options[option].Value = append(json.RawMessage(nil), offers[index].Price.Options[option].Value...)
		}
	}
	return copyOf
}

func decodeJSON(reader io.Reader, target any) error {
	data, err := readBounded(reader)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func readBounded(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxResponseBytes {
		return nil, errors.New("response exceeds client limit")
	}
	return data, nil
}

func newKey(prefix string) (string, error) {
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%x", prefix, entropy), nil
}
