//! Rail-neutral buyer client for Ausca's live catalog and paid resources.

use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::error::Error as StdError;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const ORIGIN: &str = "https://ausca.com";
pub const MAX_ARTIFACT_BYTES: usize = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub type TransportFailure = Box<dyn StdError + Send + Sync>;

/// Complete, replayable request bytes. Payment authorities must retry this
/// same request after a 402 rather than rebuilding the invocation envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub body: Option<Vec<u8>>,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// A payment-capable HTTP transport; signing and spend limits stay here.
pub trait Transport: Send + Sync {
    fn send(&self, request: &Request) -> Result<Response, TransportFailure>;
}

impl<F> Transport for F
where
    F: Fn(&Request) -> Result<Response, TransportFailure> + Send + Sync,
{
    fn send(&self, request: &Request) -> Result<Response, TransportFailure> {
        self(request)
    }
}

/// Ordinary, non-paying HTTP transport for discovery and keyless resources.
pub struct HTTPTransport(ureq::Agent);

impl Default for HTTPTransport {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .build();
        Self(config.into())
    }
}

impl Transport for HTTPTransport {
    fn send(&self, request: &Request) -> Result<Response, TransportFailure> {
        if !matches!(request.method, "GET" | "POST") {
            return Err("unsupported HTTP method".into());
        }
        let mut builder = ureq::http::Request::builder()
            .method(request.method)
            .uri(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let mut response = match &request.body {
            Some(body) => self.0.run(builder.body(body.as_slice())?)?,
            None => self.0.run(builder.body(())?)?,
        };
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES as u64)
            .read_to_vec()?;
        Ok(Response { status, body })
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Binding {
    pub digest: String,
    pub public_path: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Route {
    pub method: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Price {
    pub currency: String,
    pub model: String,
    pub minimum_minor: i64,
    pub maximum_minor: i64,
    pub policy_digest: String,
    #[serde(default)]
    pub input_field: Option<String>,
    #[serde(default)]
    pub options: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Offer {
    pub offer_id: String,
    pub title: String,
    pub description: String,
    pub revision: String,
    pub revision_digest: String,
    pub input_schema: Binding,
    pub output_schema: Binding,
    pub route: Route,
    pub price: Price,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub offer_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Attribution {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign: Option<String>,
}

#[derive(Default)]
pub struct InvokeOptions {
    pub idempotency_key: Option<String>,
    pub attribution: Option<Attribution>,
}

#[derive(Debug)]
pub enum Error {
    Invalid(String),
    Refusal {
        status: u16,
        body: Value,
        identity: Identity,
    },
    Uncertain {
        identity: Identity,
        reason: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Refusal {
                status, identity, ..
            } => write!(
                f,
                "Ausca answered {status}; inspect body and retain key {}",
                identity.idempotency_key
            ),
            Self::Uncertain { identity, .. } => write!(
                f,
                "Ausca outcome uncertain; recover {} with the same input and key {}",
                identity.offer_id, identity.idempotency_key
            ),
        }
    }
}

impl StdError for Error {}

pub struct ResultBody {
    pub status: u16,
    pub body: Value,
    pub identity: Identity,
}

pub struct Client {
    origin: String,
    reader: Arc<dyn Transport>,
    payment: Option<Arc<dyn Transport>>,
    catalog: Mutex<Option<String>>,
}

impl Client {
    pub fn new(payment: Option<Arc<dyn Transport>>) -> Self {
        Self::with_origin(ORIGIN, Arc::new(HTTPTransport::default()), payment)
    }

    pub fn with_origin(
        origin: &str,
        reader: Arc<dyn Transport>,
        payment: Option<Arc<dyn Transport>>,
    ) -> Self {
        Self {
            origin: origin.trim_end_matches('/').into(),
            reader,
            payment,
            catalog: Mutex::new(None),
        }
    }

    pub fn catalog(&self) -> Result<Vec<Offer>, Error> {
        let cached = self
            .catalog
            .lock()
            .map_err(|_| invalid("catalog lock poisoned"))?
            .clone();
        let document = match cached {
            Some(value) => value,
            None => self.refresh_catalog_document()?,
        };
        decode_offers(&document)
    }

    pub fn refresh_catalog(&self) -> Result<Vec<Offer>, Error> {
        decode_offers(&self.refresh_catalog_document()?)
    }

    fn refresh_catalog_document(&self) -> Result<String, Error> {
        let response = self.send(self.reader.as_ref(), "GET", "/catalog.json", None, vec![])?;
        if response.status != 200 {
            return Err(invalid(format!("catalog answered {}", response.status)));
        }
        let text = String::from_utf8(response.body).map_err(|error| invalid(error.to_string()))?;
        decode_offers(&text)?;
        *self
            .catalog
            .lock()
            .map_err(|_| invalid("catalog lock poisoned"))? = Some(text.clone());
        Ok(text)
    }

    pub fn offer(&self, offer_id: &str) -> Result<Offer, Error> {
        self.catalog()?
            .into_iter()
            .find(|offer| offer.offer_id == offer_id)
            .ok_or_else(|| invalid(format!("offer {offer_id:?} is not active in the catalog")))
    }

    pub fn price(&self, offer_id: &str) -> Result<Price, Error> {
        Ok(self.offer(offer_id)?.price)
    }

    pub fn envelope(
        &self,
        offer: &Offer,
        input: Value,
        options: &InvokeOptions,
    ) -> Result<(Vec<u8>, Identity), Error> {
        validate_offer(offer)?;
        let key = options
            .idempotency_key
            .clone()
            .unwrap_or_else(|| format!("ausca-{}", uuid::Uuid::new_v4()));
        validate_key(&key)?;
        if let Some(attribution) = &options.attribution {
            if !valid_label(&attribution.source, 64)
                || attribution
                    .campaign
                    .as_ref()
                    .is_some_and(|value| !valid_label(value, 128))
            {
                return Err(invalid(
                    "attribution source and campaign must be bounded lowercase labels",
                ));
            }
        }
        let identity = Identity {
            offer_id: offer.offer_id.clone(),
            idempotency_key: key.clone(),
        };
        let mut body = json!({
            "offer_id": offer.offer_id,
            "offer_revision": offer.revision,
            "offer_revision_digest": offer.revision_digest,
            "input_schema_digest": offer.input_schema.digest,
            "output_schema_digest": offer.output_schema.digest,
            "input": input,
            "idempotency_key": key,
        });
        if let Some(attribution) = &options.attribution {
            body["attribution"] =
                serde_json::to_value(attribution).map_err(|error| invalid(error.to_string()))?;
        }
        let bytes = serde_json::to_vec(&body).map_err(|error| invalid(error.to_string()))?;
        Ok((bytes, identity))
    }

    pub fn probe(
        &self,
        offer_id: &str,
        input: Value,
        options: InvokeOptions,
    ) -> Result<(Response, Identity), Error> {
        let offer = self.offer(offer_id)?;
        let (body, identity) = self.envelope(&offer, input, &options)?;
        let response = self.send(
            self.reader.as_ref(),
            "POST",
            &offer.route.path,
            Some(body),
            json_header(),
        )?;
        Ok((response, identity))
    }

    pub fn invoke(
        &self,
        offer_id: &str,
        input: Value,
        options: InvokeOptions,
    ) -> Result<ResultBody, Error> {
        self.invoke_with(offer_id, input, options, |_| Ok(()))
    }

    pub fn invoke_with<F>(
        &self,
        offer_id: &str,
        input: Value,
        options: InvokeOptions,
        before_payment: F,
    ) -> Result<ResultBody, Error>
    where
        F: FnOnce(&Identity) -> Result<(), Error>,
    {
        let payment = self
            .payment
            .as_ref()
            .ok_or_else(|| invalid("payment authority is required for invoke"))?;
        let offer = self.offer(offer_id)?;
        let (body, identity) = self.envelope(&offer, input, &options)?;
        before_payment(&identity)?;
        let response = self
            .send(
                payment.as_ref(),
                "POST",
                &offer.route.path,
                Some(body),
                json_header(),
            )
            .map_err(|error| Error::Uncertain {
                identity: identity.clone(),
                reason: error.to_string(),
            })?;
        let decoded: Value =
            serde_json::from_slice(&response.body).map_err(|error| Error::Uncertain {
                identity: identity.clone(),
                reason: error.to_string(),
            })?;
        if response.status >= 400 {
            return Err(Error::Refusal {
                status: response.status,
                body: decoded,
                identity,
            });
        }
        Ok(ResultBody {
            status: response.status,
            body: decoded,
            identity,
        })
    }

    pub fn invocation(&self, invocation_id: &str) -> Result<Value, Error> {
        if invocation_id.is_empty() {
            return Err(invalid("invocation ID is required"));
        }
        let path = format!(
            "/v1/invocations/{}",
            utf8_percent_encode(invocation_id, NON_ALPHANUMERIC)
        );
        let response = self.send(self.reader.as_ref(), "GET", &path, None, vec![])?;
        if response.status != 200 {
            return Err(invalid(format!(
                "invocation read answered {}",
                response.status
            )));
        }
        serde_json::from_slice(&response.body).map_err(|error| invalid(error.to_string()))
    }

    pub fn commit(
        &self,
        bytes: &[u8],
        media_type: &str,
        idempotency_key: Option<&str>,
    ) -> Result<Value, Error> {
        if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(invalid("artifact size exceeds the platform ingress limit"));
        }
        if media_type.is_empty() || media_type.len() > 200 || media_type.trim() != media_type {
            return Err(invalid("invalid artifact media type"));
        }
        let key = idempotency_key
            .map(str::to_owned)
            .unwrap_or_else(|| format!("ausca-artifact-{}", uuid::Uuid::new_v4()));
        validate_key(&key)?;
        let digest = format!("sha256:{:x}", Sha256::digest(bytes));
        let body = serde_json::to_vec(&json!({
            "data_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "content_digest": digest,
            "media_type": media_type,
            "idempotency_key": key,
        }))
        .map_err(|error| invalid(error.to_string()))?;
        let response = self
            .send(
                self.reader.as_ref(),
                "POST",
                "/v1/artifacts",
                Some(body),
                json_header(),
            )
            .map_err(|error| {
                invalid(format!(
                    "artifact commit uncertain; reuse key {key}: {error}"
                ))
            })?;
        if response.status != 200 {
            return Err(invalid(format!(
                "artifact ingress answered {}; reuse key {key}",
                response.status
            )));
        }
        let result: Value = serde_json::from_slice(&response.body).map_err(|error| {
            invalid(format!(
                "artifact commit uncertain; reuse key {key}: {error}"
            ))
        })?;
        let artifact = result.get("artifact").ok_or_else(|| {
            invalid(format!(
                "artifact ingress returned malformed evidence; reuse key {key}"
            ))
        })?;
        if result["status"] != "stored"
            || artifact["artifact_ref"].as_str().is_none_or(str::is_empty)
            || artifact["artifact_ref"]
                .as_str()
                .is_some_and(|value| value.len() > 512)
            || artifact["content_digest"] != digest
            || artifact["media_type"] != media_type
            || artifact["size_bytes"] != bytes.len()
            || artifact["created_at"].as_str().is_none()
        {
            return Err(invalid(format!(
                "artifact ingress returned mismatched evidence; reuse key {key}"
            )));
        }
        Ok(json!({
            "artifact_ref": artifact["artifact_ref"],
            "content_digest": digest,
            "media_type": media_type,
        }))
    }

    pub fn access(
        &self,
        artifact_ref: &str,
        idempotency_key: Option<&str>,
    ) -> Result<Value, Error> {
        if artifact_ref.is_empty() || artifact_ref.len() > 512 {
            return Err(invalid("invalid artifact reference"));
        }
        let key = idempotency_key
            .map(str::to_owned)
            .unwrap_or_else(|| format!("ausca-{}", uuid::Uuid::new_v4()));
        validate_key(&key)?;
        let path = format!(
            "/v1/artifacts/{}/access",
            utf8_percent_encode(artifact_ref, NON_ALPHANUMERIC)
        );
        let response = self.send(
            self.reader.as_ref(),
            "POST",
            &path,
            None,
            vec![("Idempotency-Key".into(), key)],
        )?;
        if response.status != 200 {
            return Err(invalid(format!(
                "artifact access answered {}",
                response.status
            )));
        }
        let result: Value =
            serde_json::from_slice(&response.body).map_err(|error| invalid(error.to_string()))?;
        let artifact = result
            .get("artifact")
            .ok_or_else(|| invalid("artifact access returned malformed evidence"))?;
        if result["status"] != "ready"
            || artifact["artifact_ref"] != artifact_ref
            || artifact["content_digest"].as_str().is_none()
            || artifact["download_url"].as_str().is_none()
            || artifact["expires_at"].as_str().is_none()
        {
            return Err(invalid("artifact access returned invalid evidence"));
        }
        Ok(artifact.clone())
    }

    fn send(
        &self,
        transport: &dyn Transport,
        method: &'static str,
        path: &str,
        body: Option<Vec<u8>>,
        headers: Vec<(String, String)>,
    ) -> Result<Response, Error> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(invalid("invalid resource path"));
        }
        transport
            .send(&Request {
                method,
                url: format!("{}{path}", self.origin),
                body,
                headers,
            })
            .map_err(|error| invalid(error.to_string()))
    }
}

fn decode_offers(document: &str) -> Result<Vec<Offer>, Error> {
    #[derive(Deserialize)]
    struct Catalog {
        offers: Vec<Offer>,
    }
    let catalog: Catalog =
        serde_json::from_str(document).map_err(|error| invalid(format!("catalog: {error}")))?;
    for offer in &catalog.offers {
        validate_offer(offer)?;
    }
    Ok(catalog.offers)
}

fn validate_offer(offer: &Offer) -> Result<(), Error> {
    if offer.offer_id.is_empty()
        || offer.revision.is_empty()
        || offer.revision_digest.is_empty()
        || offer.input_schema.digest.is_empty()
        || offer.output_schema.digest.is_empty()
        || offer.route.method != "POST"
        || !offer.route.path.starts_with("/v1/")
        || offer.route.path.contains("..")
        || offer.route.path.contains(['?', '#'])
    {
        return Err(invalid(format!(
            "invalid catalog binding for {:?}",
            offer.offer_id
        )));
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<(), Error> {
    if !(16..=128).contains(&key.len()) || key.trim() != key || key.chars().any(char::is_control) {
        return Err(invalid(
            "idempotency key must be 16 to 128 clean UTF-8 bytes",
        ));
    }
    Ok(())
}

fn valid_label(value: &str, max: usize) -> bool {
    value.len() <= max
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn json_header() -> Vec<(String, String)> {
    vec![("Content-Type".into(), "application/json".into())]
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CATALOG: &str = r#"{"offers":[{"offer_id":"browser.session","title":"Browser","description":"Session","revision":"r1","revision_digest":"sha256:revision","input_schema":{"digest":"sha256:input","public_path":"/input.json"},"output_schema":{"digest":"sha256:output","public_path":"/output.json"},"route":{"method":"POST","path":"/v1/lease-browser"},"price":{"currency":"USD","model":"input_choice","minimum_minor":5,"maximum_minor":20,"policy_digest":"sha256:price"}}]}"#;

    fn read_transport() -> Arc<dyn Transport> {
        Arc::new(|request: &Request| -> Result<Response, TransportFailure> {
            if request.url.ends_with("/catalog.json") {
                Ok(Response {
                    status: 200,
                    body: CATALOG.as_bytes().to_vec(),
                })
            } else {
                Ok(Response {
                    status: 402,
                    body: br#"{"accepts":[]}"#.to_vec(),
                })
            }
        })
    }

    #[test]
    fn paid_retry_preserves_bytes_and_identity() {
        let seen = Arc::new(Mutex::new(Vec::<Request>::new()));
        let sent = seen.clone();
        let payment: Arc<dyn Transport> = Arc::new(
            move |request: &Request| -> Result<Response, TransportFailure> {
                sent.lock().unwrap().push(request.clone());
                Ok(Response { status: 200, body: br#"{"status":"succeeded","receipt_ref":{"public_url":"https://runx.ai/r/test"}}"#.to_vec() })
            },
        );
        let client = Client::with_origin("https://example.com", read_transport(), Some(payment));
        let options = || InvokeOptions {
            idempotency_key: Some("browser-purchase-0001".into()),
            ..Default::default()
        };
        let mut retained = None;
        let first = client
            .invoke_with(
                "browser.session",
                json!({"duration_seconds":600}),
                options(),
                |identity| {
                    retained = Some(identity.clone());
                    Ok(())
                },
            )
            .unwrap();
        client
            .invoke(
                "browser.session",
                json!({"duration_seconds":600}),
                options(),
            )
            .unwrap();
        assert_eq!(retained, Some(first.identity));
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
        let bound: Value = serde_json::from_slice(calls[0].body.as_ref().unwrap()).unwrap();
        assert_eq!(bound["offer_revision_digest"], "sha256:revision");
    }

    #[test]
    fn probe_does_not_call_payment() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let payment: Arc<dyn Transport> =
            Arc::new(move |_: &Request| -> Result<Response, TransportFailure> {
                count.fetch_add(1, Ordering::Relaxed);
                Err("payment must not run".into())
            });
        let client = Client::with_origin("https://example.com", read_transport(), Some(payment));
        let (challenge, identity) = client
            .probe(
                "browser.session",
                json!({}),
                InvokeOptions {
                    idempotency_key: Some("browser-purchase-0001".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(challenge.status, 402);
        assert_eq!(identity.idempotency_key, "browser-purchase-0001");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn uncertain_and_refusal_keep_purchase_identity() {
        let failed: Arc<dyn Transport> =
            Arc::new(|_: &Request| -> Result<Response, TransportFailure> {
                Err("closed after send".into())
            });
        let client = Client::with_origin("https://example.com", read_transport(), Some(failed));
        let key = "browser-purchase-0001";
        let error = client
            .invoke(
                "browser.session",
                json!({}),
                InvokeOptions {
                    idempotency_key: Some(key.into()),
                    ..Default::default()
                },
            )
            .err()
            .unwrap();
        match error {
            Error::Uncertain { identity, .. } => assert_eq!(identity.idempotency_key, key),
            other => panic!("wrong error: {other}"),
        }
        let refused: Arc<dyn Transport> =
            Arc::new(|_: &Request| -> Result<Response, TransportFailure> {
                Ok(Response {
                    status: 409,
                    body: br#"{"code":"replay_conflict"}"#.to_vec(),
                })
            });
        let client = Client::with_origin("https://example.com", read_transport(), Some(refused));
        let error = client
            .invoke(
                "browser.session",
                json!({}),
                InvokeOptions {
                    idempotency_key: Some(key.into()),
                    ..Default::default()
                },
            )
            .err()
            .unwrap();
        match error {
            Error::Refusal {
                status,
                body,
                identity,
            } => {
                assert_eq!(status, 409);
                assert_eq!(body["code"], "replay_conflict");
                assert_eq!(identity.idempotency_key, key);
            }
            other => panic!("wrong error: {other}"),
        }
    }

    #[test]
    fn invalid_catalog_route_is_rejected() {
        let document = CATALOG.replace("/v1/lease-browser", "//evil.example/path");
        let read: Arc<dyn Transport> =
            Arc::new(move |_: &Request| -> Result<Response, TransportFailure> {
                Ok(Response {
                    status: 200,
                    body: document.as_bytes().to_vec(),
                })
            });
        let client = Client::with_origin("https://example.com", read, None);
        assert!(client.catalog().is_err());
    }

    #[test]
    fn artifact_commit_and_bodyless_access() {
        let read: Arc<dyn Transport> = Arc::new(
            |request: &Request| -> Result<Response, TransportFailure> {
                if request.url.ends_with("/v1/artifacts") {
                    let body: Value =
                        serde_json::from_slice(request.body.as_ref().unwrap()).unwrap();
                    assert_eq!(body["data_base64"], "dGVzdCBieXRlcw==");
                    assert_eq!(body["idempotency_key"], "artifact-upload-0001");
                    return Ok(Response {
                        status: 200,
                        body: serde_json::to_vec(&json!({
                            "status":"stored", "artifact":{
                                "artifact_ref":"art_1", "content_digest":body["content_digest"],
                                "media_type":"text/plain", "size_bytes":10, "created_at":"now"
                            }
                        }))
                        .unwrap(),
                    });
                }
                if request.url.ends_with("/v1/artifacts/art%5F1/access") {
                    assert!(request.body.is_none());
                    assert!(request
                        .headers
                        .contains(&("Idempotency-Key".into(), "artifact-access-0001".into())));
                    return Ok(Response { status: 200, body: br#"{"status":"ready","artifact":{"artifact_ref":"art_1","content_digest":"sha256:test","media_type":"text/plain","size_bytes":10,"created_at":"now","download_url":"https://example.com/download","expires_at":"later"}}"#.to_vec() });
                }
                Err(format!("unexpected route {}", request.url).into())
            },
        );
        let client = Client::with_origin("https://example.com", read, None);
        let commitment = client
            .commit(b"test bytes", "text/plain", Some("artifact-upload-0001"))
            .unwrap();
        assert_eq!(commitment["artifact_ref"], "art_1");
        let access = client
            .access("art_1", Some("artifact-access-0001"))
            .unwrap();
        assert_eq!(access["download_url"], "https://example.com/download");
    }

    #[test]
    fn live_catalog_when_requested() {
        if std::env::var("AUSCA_LIVE_TEST").as_deref() != Ok("1") {
            return;
        }
        let client = Client::new(None);
        let offers = client.catalog().unwrap();
        assert!(!offers.is_empty());
        for offer in offers {
            client
                .envelope(&offer, json!({}), &InvokeOptions::default())
                .unwrap();
        }
    }
}
