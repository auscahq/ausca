package ausca

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// MaxArtifactBytes is the platform ingress ceiling, not an offer's limit.
// Consult the live catalog for each offer's usable artifact size.
const MaxArtifactBytes = 25 << 20

type ArtifactCommitment struct {
	ArtifactRef   string `json:"artifact_ref"`
	ContentDigest string `json:"content_digest"`
	MediaType     string `json:"media_type"`
}

type ArtifactAccess struct {
	ArtifactCommitment
	SizeBytes   int64  `json:"size_bytes"`
	CreatedAt   string `json:"created_at"`
	DownloadURL string `json:"download_url"`
	ExpiresAt   string `json:"expires_at"`
}

// Commit stores bytes on Ausca's keyless artifact ingress. Reuse key only to
// recover the same bytes and media type after an uncertain upload.
func (c *Client) Commit(ctx context.Context, data []byte, mediaType, key string) (ArtifactCommitment, error) {
	if len(data) == 0 || len(data) > MaxArtifactBytes {
		return ArtifactCommitment{}, fmt.Errorf("artifact must contain 1 to %d bytes", MaxArtifactBytes)
	}
	if mediaType == "" || len(mediaType) > 200 || strings.TrimSpace(mediaType) != mediaType {
		return ArtifactCommitment{}, errors.New("invalid artifact media type")
	}
	if key == "" {
		var err error
		key, err = newKey("ausca-artifact-")
		if err != nil {
			return ArtifactCommitment{}, err
		}
	}
	if err := validateKey(key); err != nil {
		return ArtifactCommitment{}, err
	}
	digest := sha256.Sum256(data)
	contentDigest := "sha256:" + hex.EncodeToString(digest[:])
	body, err := json.Marshal(struct {
		DataBase64    string `json:"data_base64"`
		ContentDigest string `json:"content_digest"`
		MediaType     string `json:"media_type"`
		Key           string `json:"idempotency_key"`
	}{base64.StdEncoding.EncodeToString(data), contentDigest, mediaType, key})
	if err != nil {
		return ArtifactCommitment{}, err
	}
	response, err := c.request(ctx, c.reader, http.MethodPost, "/v1/artifacts", body, nil)
	if err != nil {
		return ArtifactCommitment{}, fmt.Errorf("artifact commit uncertain; reuse key %s: %w", key, err)
	}
	defer response.Body.Close()
	var result struct {
		Status   string `json:"status"`
		Artifact struct {
			ArtifactCommitment
			SizeBytes int64  `json:"size_bytes"`
			CreatedAt string `json:"created_at"`
		} `json:"artifact"`
	}
	if err := decodeJSON(response.Body, &result); err != nil {
		return ArtifactCommitment{}, fmt.Errorf("artifact commit uncertain; reuse key %s: %w", key, err)
	}
	if response.StatusCode != http.StatusOK {
		return ArtifactCommitment{}, fmt.Errorf("artifact ingress answered %d; reuse key %s", response.StatusCode, key)
	}
	got := result.Artifact
	if result.Status != "stored" || got.ArtifactRef == "" || len(got.ArtifactRef) > 512 ||
		got.ContentDigest != contentDigest || got.MediaType != mediaType || got.SizeBytes != int64(len(data)) || got.CreatedAt == "" {
		return ArtifactCommitment{}, fmt.Errorf("artifact ingress returned mismatched evidence; reuse key %s", key)
	}
	return got.ArtifactCommitment, nil
}

// Access mints short-lived download access. HTTP carries no request body;
// artifact_ref is the path parameter and the identity is a request header.
func (c *Client) Access(ctx context.Context, artifactRef, key string) (ArtifactAccess, error) {
	if artifactRef == "" || len(artifactRef) > 512 {
		return ArtifactAccess{}, errors.New("invalid artifact reference")
	}
	if key == "" {
		var err error
		key, err = newKey("ausca-")
		if err != nil {
			return ArtifactAccess{}, err
		}
	}
	if err := validateKey(key); err != nil {
		return ArtifactAccess{}, err
	}
	header := http.Header{"Idempotency-Key": []string{key}}
	response, err := c.request(ctx, c.reader, http.MethodPost, "/v1/artifacts/"+url.PathEscape(artifactRef)+"/access", nil, header)
	if err != nil {
		return ArtifactAccess{}, err
	}
	defer response.Body.Close()
	var result struct {
		Status   string         `json:"status"`
		Artifact ArtifactAccess `json:"artifact"`
	}
	if err := decodeJSON(response.Body, &result); err != nil {
		return ArtifactAccess{}, err
	}
	if response.StatusCode != http.StatusOK || result.Status != "ready" ||
		result.Artifact.ArtifactRef != artifactRef || result.Artifact.ContentDigest == "" ||
		result.Artifact.DownloadURL == "" || result.Artifact.ExpiresAt == "" {
		return ArtifactAccess{}, fmt.Errorf("artifact access answered %d with invalid evidence", response.StatusCode)
	}
	return result.Artifact, nil
}
