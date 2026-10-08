# frozen_string_literal: true

require "base64"
require "digest"
require "json"
require "net/http"
require "securerandom"
require "uri"

module Ausca
  ORIGIN = "https://ausca.com"
  MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
  MAX_RESPONSE_BYTES = 8 * 1024 * 1024

  class Error < StandardError; end

  class RefusalError < Error
    attr_reader :status, :body, :identity

    def initialize(status, body, identity)
      @status, @body, @identity = status, body, identity
      super("Ausca answered #{status}; inspect the body and retain purchase key #{identity[:idempotency_key]}")
    end
  end

  class UncertainError < Error
    attr_reader :identity

    def initialize(identity)
      @identity = identity
      super("Ausca outcome uncertain; recover #{identity[:offer_id]} with the same input and key #{identity[:idempotency_key]}")
    end
  end

  # The default transport performs ordinary HTTP. A paid authority implements
  # the same #call(uri, request) method and handles 402 challenges under its own
  # spend policy. Wallets, signing, and provider SDKs never enter this package.
  class HTTPTransport
    def call(uri, request)
      Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 10, read_timeout: 60) do |http|
        http.request(request)
      end
    end
  end

  class Client
    def initialize(payment: nil, origin: ORIGIN, http: HTTPTransport.new)
      @origin = origin.delete_suffix("/")
      @http = http
      @payment = payment
      @catalog_json = nil
    end

    def catalog(refresh: false)
      if @catalog_json.nil? || refresh
        response = request(@http, :get, "/catalog.json")
        raise Error, "catalog answered #{response.code}" unless response.code.to_i == 200

        document = decode_json(response.body)
        offers = document.fetch("offers")
        raise Error, "catalog has no offers" unless offers.is_a?(Array)

        offers.each { |offer| validate_offer(offer) }
        @catalog_json = response.body.dup.freeze
      end
      JSON.parse(@catalog_json)
    end

    def offer(offer_id)
      catalog.fetch("offers").find { |entry| entry.fetch("offer_id") == offer_id } ||
        raise(Error, "offer #{offer_id.inspect} is not active in the catalog")
    end

    def price(offer_id)
      offer(offer_id).fetch("price")
    end

    def envelope(bound_offer, input, idempotency_key: nil, attribution: nil)
      validate_offer(bound_offer)
      key = idempotency_key || new_key("ausca-")
      validate_key(key)
      validate_attribution(attribution) unless attribution.nil?
      {
        "offer_id" => bound_offer.fetch("offer_id"),
        "offer_revision" => bound_offer.fetch("revision"),
        "offer_revision_digest" => bound_offer.fetch("revision_digest"),
        "input_schema_digest" => bound_offer.fetch("input_schema").fetch("digest"),
        "output_schema_digest" => bound_offer.fetch("output_schema").fetch("digest"),
        "input" => input,
        "idempotency_key" => key
      }.tap { |body| body["attribution"] = attribution unless attribution.nil? }
    end

    # Read-only challenge inspection; never calls the payment authority.
    def probe(offer_id, input, idempotency_key: nil, attribution: nil)
      bound = offer(offer_id)
      body = envelope(bound, input, idempotency_key: idempotency_key, attribution: attribution)
      [request(@http, :post, bound.fetch("route").fetch("path"), body: JSON.generate(body)), identity(body)]
    end

    # The caller may persist the identity in the block before payment begins.
    # On uncertainty, retry with identical input and the same key.
    def invoke(offer_id, input, idempotency_key: nil, attribution: nil)
      raise Error, "payment authority is required for invoke" if @payment.nil?

      bound = offer(offer_id)
      body = envelope(bound, input, idempotency_key: idempotency_key, attribution: attribution)
      purchase = identity(body)
      yield(purchase) if block_given?
      response = begin
        request(@payment, :post, bound.fetch("route").fetch("path"), body: JSON.generate(body))
      rescue StandardError
        raise UncertainError, purchase
      end
      decoded = begin
        decode_json(response.body)
      rescue StandardError
        raise UncertainError, purchase
      end
      raise RefusalError.new(response.code.to_i, decoded, purchase) if response.code.to_i >= 400

      { status: response.code.to_i, body: decoded, identity: purchase }
    end

    def invocation(invocation_id)
      raise Error, "invocation ID is required" if invocation_id.to_s.empty?

      response = request(@http, :get, "/v1/invocations/#{URI.encode_www_form_component(invocation_id)}")
      raise Error, "invocation read answered #{response.code}" unless response.code.to_i == 200

      decode_json(response.body)
    end

    # Keyless artifact ingress. Reuse a key only for the same bytes and media
    # type after an uncertain response. The offer may impose a lower limit.
    def commit(bytes, media_type, idempotency_key: nil)
      raise Error, "artifact must contain 1 to #{MAX_ARTIFACT_BYTES} bytes" unless bytes.bytesize.between?(1, MAX_ARTIFACT_BYTES)
      raise Error, "invalid media type" unless media_type.is_a?(String) && !media_type.empty? && media_type.bytesize <= 200 && media_type.strip == media_type

      key = idempotency_key || new_key("ausca-artifact-")
      validate_key(key)
      digest = "sha256:#{Digest::SHA256.hexdigest(bytes)}"
      body = JSON.generate(data_base64: Base64.strict_encode64(bytes), content_digest: digest,
                           media_type: media_type, idempotency_key: key)
      response = begin
        request(@http, :post, "/v1/artifacts", body: body)
      rescue StandardError
        raise Error, "artifact commit uncertain; reuse key #{key}"
      end
      raise Error, "artifact ingress answered #{response.code}; reuse key #{key}" unless response.code.to_i == 200

      result = decode_json(response.body)
      artifact = result.fetch("artifact")
      unless result.fetch("status") == "stored" && artifact.fetch("artifact_ref").is_a?(String) &&
             artifact.fetch("artifact_ref").bytesize.between?(1, 512) &&
             artifact.fetch("content_digest") == digest && artifact.fetch("media_type") == media_type &&
             artifact.fetch("size_bytes") == bytes.bytesize && artifact.fetch("created_at").is_a?(String)
        raise Error, "artifact ingress returned mismatched evidence; reuse key #{key}"
      end
      artifact.slice("artifact_ref", "content_digest", "media_type")
    rescue KeyError, JSON::ParserError
      raise Error, "artifact ingress returned malformed evidence; reuse key #{key}"
    end

    # The HTTP access route requires a header and no request body.
    def access(artifact_ref, idempotency_key: nil)
      raise Error, "invalid artifact reference" unless artifact_ref.is_a?(String) && artifact_ref.bytesize.between?(1, 512)

      key = idempotency_key || new_key("ausca-")
      validate_key(key)
      response = request(@http, :post,
                         "/v1/artifacts/#{URI.encode_www_form_component(artifact_ref)}/access",
                         headers: { "Idempotency-Key" => key })
      raise Error, "artifact access answered #{response.code}" unless response.code.to_i == 200

      result = decode_json(response.body)
      artifact = result.fetch("artifact")
      unless result.fetch("status") == "ready" && artifact.fetch("artifact_ref") == artifact_ref &&
             artifact.fetch("content_digest").is_a?(String) && artifact.fetch("download_url").is_a?(String) &&
             artifact.fetch("expires_at").is_a?(String)
        raise Error, "artifact access returned invalid evidence"
      end
      artifact
    rescue KeyError, JSON::ParserError
      raise Error, "artifact access returned malformed evidence"
    end

    private

    def request(transport, method, path, body: nil, headers: {})
      raise Error, "invalid resource path" unless path.start_with?("/") && !path.start_with?("//")

      uri = URI.parse("#{@origin}#{path}")
      request = method == :post ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
      request["Content-Type"] = "application/json" unless body.nil?
      headers.each { |name, value| request[name] = value }
      request.body = body unless body.nil?
      response = transport.call(uri, request)
      raise Error, "response exceeds #{MAX_RESPONSE_BYTES} bytes" if response.body.to_s.bytesize > MAX_RESPONSE_BYTES

      response
    end

    def decode_json(body)
      JSON.parse(body.to_s)
    rescue JSON::ParserError => error
      raise Error, "invalid JSON response: #{error.message}"
    end

    def identity(body)
      { offer_id: body.fetch("offer_id"), idempotency_key: body.fetch("idempotency_key") }
    end

    def validate_offer(bound)
      route = bound.fetch("route")
      path = route.fetch("path")
      valid = bound.fetch("offer_id").is_a?(String) && !bound.fetch("offer_id").empty? &&
              %w[revision revision_digest].all? { |field| bound.fetch(field).is_a?(String) && !bound.fetch(field).empty? } &&
              %w[input_schema output_schema].all? { |field| !bound.fetch(field).fetch("digest").to_s.empty? } &&
              route.fetch("method") == "POST" && path.is_a?(String) && path.start_with?("/v1/") &&
              !path.include?("..") && !path.match?(/[?#]/)
      raise Error, "invalid catalog binding for #{bound['offer_id'].inspect}" unless valid
    rescue KeyError, NoMethodError
      raise Error, "malformed catalog offer binding"
    end

    def validate_key(key)
      valid = key.is_a?(String) && key.valid_encoding? && key.bytesize.between?(16, 128) &&
              key.strip == key && !key.match?(/[\x00-\x1f\x7f]/)
      raise Error, "idempotency key must be 16 to 128 clean UTF-8 bytes" unless valid
    end

    def validate_attribution(value)
      valid = value.is_a?(Hash) && value.keys.all? { |key| %w[source campaign].include?(key.to_s) } &&
              label?(value[:source] || value["source"], 64) &&
              (value[:campaign] || value["campaign"]).then { |campaign| campaign.nil? || label?(campaign, 128) }
      raise Error, "attribution source and campaign must be bounded lowercase labels" unless valid
    end

    def label?(value, max)
      value.is_a?(String) && value.bytesize <= max && value.match?(/\A[a-z0-9][a-z0-9._-]*\z/)
    end

    def new_key(prefix)
      "#{prefix}#{SecureRandom.hex(16)}"
    end
  end
end
