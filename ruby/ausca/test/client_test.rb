# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/ausca"

class ClientTest < Minitest::Test
  Response = Struct.new(:code, :body)
  CATALOG = {
    offers: [{
      offer_id: "browser.session", title: "Browser", description: "Session",
      revision: "r1", revision_digest: "sha256:revision",
      input_schema: { digest: "sha256:input", public_path: "/input.json" },
      output_schema: { digest: "sha256:output", public_path: "/output.json" },
      route: { method: "POST", path: "/v1/lease-browser" },
      price: { currency: "USD", model: "input_choice", minimum_minor: 5, maximum_minor: 20,
               policy_digest: "sha256:price" }
    }]
  }.to_json

  class Transport
    attr_reader :calls

    def initialize(&block)
      @block = block
      @calls = []
    end

    def call(uri, request)
      @calls << [uri.to_s, request.method, request.body, request.to_hash]
      @block.call(uri, request)
    end
  end

  def catalog_transport(&block)
    Transport.new do |uri, request|
      uri.path == "/catalog.json" ? Response.new("200", CATALOG) : block.call(uri, request)
    end
  end

  def test_retry_keeps_exact_envelope_and_identity
    wire = []
    read = catalog_transport { flunk "paid request used read transport" }
    payment = Transport.new do |_uri, request|
      wire << request.body
      Response.new("200", { status: "succeeded", receipt_ref: { public_url: "https://runx.ai/r/test" } }.to_json)
    end
    client = Ausca::Client.new(origin: "https://example.com", http: read, payment: payment)
    saved = nil
    result = client.invoke("browser.session", { duration_seconds: 600 }, idempotency_key: "browser-purchase-0001") do |identity|
      saved = identity
      assert_empty payment.calls
    end
    client.invoke("browser.session", { duration_seconds: 600 }, idempotency_key: saved[:idempotency_key])
    assert_equal saved, result[:identity]
    assert_equal wire[0], wire[1]
    assert_equal "sha256:revision", JSON.parse(wire[0]).fetch("offer_revision_digest")
  end

  def test_probe_bypasses_payment
    read = catalog_transport { |_uri, _request| Response.new("402", '{"accepts":[]}') }
    payment = Transport.new { flunk "probe used payment authority" }
    client = Ausca::Client.new(origin: "https://example.com", http: read, payment: payment)
    response, identity = client.probe("browser.session", { duration_seconds: 600 }, idempotency_key: "browser-purchase-0001")
    assert_equal "402", response.code
    assert_equal "browser-purchase-0001", identity[:idempotency_key]
    assert_empty payment.calls
  end

  def test_uncertain_and_refusal_keep_identity
    read = catalog_transport { flunk "unexpected read" }
    payment = Transport.new { raise IOError, "closed after send" }
    client = Ausca::Client.new(origin: "https://example.com", http: read, payment: payment)
    uncertain = assert_raises(Ausca::UncertainError) do
      client.invoke("browser.session", {}, idempotency_key: "browser-purchase-0001")
    end
    assert_equal "browser-purchase-0001", uncertain.identity[:idempotency_key]

    refused = Ausca::Client.new(origin: "https://example.com", http: read,
                                payment: Transport.new { Response.new("409", '{"code":"replay_conflict"}') })
    refusal = assert_raises(Ausca::RefusalError) do
      refused.invoke("browser.session", {}, idempotency_key: "browser-purchase-0001")
    end
    assert_equal 409, refusal.status
    assert_equal "replay_conflict", refusal.body.fetch("code")
    assert_equal uncertain.identity, refusal.identity
  end

  def test_failed_identity_persistence_aborts_before_payment
    read = catalog_transport { flunk "unexpected read" }
    payment = Transport.new { flunk "payment began" }
    client = Ausca::Client.new(origin: "https://example.com", http: read, payment: payment)
    error = assert_raises(IOError) do
      client.invoke("browser.session", {}) { raise IOError, "disk unavailable" }
    end
    assert_equal "disk unavailable", error.message
    assert_empty payment.calls
  end

  def test_commit_and_bodyless_access
    read = catalog_transport do |uri, request|
      case uri.path
      when "/v1/artifacts"
        body = JSON.parse(request.body)
        assert_equal "dGVzdCBieXRlcw==", body.fetch("data_base64")
        assert_equal "artifact-upload-0001", body.fetch("idempotency_key")
        Response.new("200", { status: "stored", artifact: {
          artifact_ref: "art_1", content_digest: body.fetch("content_digest"),
          media_type: "text/plain", size_bytes: 10, created_at: "now"
        } }.to_json)
      when "/v1/artifacts/art_1/access"
        assert_nil request.body
        assert_equal "artifact-access-0001", request["Idempotency-Key"]
        Response.new("200", { status: "ready", artifact: {
          artifact_ref: "art_1", content_digest: "sha256:test", media_type: "text/plain",
          size_bytes: 10, created_at: "now", download_url: "https://example.com/download", expires_at: "later"
        } }.to_json)
      else
        flunk "unexpected route #{uri.path}"
      end
    end
    client = Ausca::Client.new(origin: "https://example.com", http: read)
    commitment = client.commit("test bytes", "text/plain", idempotency_key: "artifact-upload-0001")
    assert_equal "art_1", commitment.fetch("artifact_ref")
    access = client.access("art_1", idempotency_key: "artifact-access-0001")
    assert_equal "https://example.com/download", access.fetch("download_url")
  end

  def test_catalog_route_cannot_escape_origin
    bad = CATALOG.sub("/v1/lease-browser", "//outside.example/path")
    client = Ausca::Client.new(http: Transport.new { Response.new("200", bad) })
    assert_raises(Ausca::Error) { client.catalog }
  end
end
