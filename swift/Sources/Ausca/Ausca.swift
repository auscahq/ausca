import Crypto
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct Identity: Sendable, Equatable {
    public let offerId: String
    public let idempotencyKey: String
}

public enum AuscaError: Error, Sendable {
    case invalid(String)
    case refusal(status: Int, body: Data, identity: Identity)
    case uncertain(Identity)
}

public protocol Transport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Ordinary read/keyless HTTP. Payment transports implement the same port.
public struct HTTPTransport: Transport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AuscaError.invalid("HTTP response has no status")
        }
        return (data, http)
    }
}

public enum JSONValue: Decodable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([JSONValue].self) { self = .array(array) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
}

public struct PriceOption: Decodable, Sendable {
    public let amountMinor: Int
    public let value: JSONValue
}

public struct Price: Decodable, Sendable {
    public let currency: String
    public let model: String
    public let minimumMinor: Int
    public let maximumMinor: Int
    public let policyDigest: String
    public let inputField: String?
    public let options: [PriceOption]?
}

public struct Binding: Decodable, Sendable {
    public let digest: String
    public let publicPath: String
}

public struct Route: Decodable, Sendable {
    public let method: String
    public let path: String
}

public struct Offer: Decodable, Sendable {
    public let offerId: String
    public let title: String
    public let description: String
    public let revision: String
    public let revisionDigest: String
    public let inputSchema: Binding
    public let outputSchema: Binding
    public let route: Route
    public let price: Price
}

public struct Attribution: Encodable, Sendable {
    public let source: String
    public let campaign: String?

    public init(source: String, campaign: String? = nil) {
        self.source = source
        self.campaign = campaign
    }
}

public struct InvocationResult: Sendable {
    public let status: Int
    public let body: Data
    public let identity: Identity
}

public struct ArtifactCommitment: Decodable, Sendable {
    public let artifactRef: String
    public let contentDigest: String
    public let mediaType: String
}

public struct ArtifactAccess: Decodable, Sendable {
    public let artifactRef: String
    public let contentDigest: String
    public let mediaType: String
    public let sizeBytes: Int
    public let createdAt: String
    public let downloadUrl: String
    public let expiresAt: String
}

public actor AuscaClient {
    public static let origin = "https://ausca.com"
    public static let maxArtifactBytes = 25 * 1024 * 1024

    private let serviceOrigin: String
    private let read: any Transport
    private let payment: (any Transport)?
    private var cachedOffers: [Offer]?

    public init(payment: (any Transport)? = nil, origin: String = AuscaClient.origin, read: any Transport = HTTPTransport()) {
        self.serviceOrigin = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
        self.read = read
        self.payment = payment
    }

    public func catalog(refresh: Bool = false) async throws -> [Offer] {
        if !refresh, let cachedOffers { return cachedOffers }
        let (data, response) = try await request(read, method: "GET", path: "/catalog.json")
        guard response.statusCode == 200 else { throw AuscaError.invalid("catalog answered \(response.statusCode)") }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let offers = try decoder.decode(CatalogDocument.self, from: data).offers
        for offer in offers { try validate(offer) }
        cachedOffers = offers
        return offers
    }

    public func offer(_ offerId: String) async throws -> Offer {
        guard let offer = try await catalog().first(where: { $0.offerId == offerId }) else {
            throw AuscaError.invalid("offer \(offerId) is not active in the catalog")
        }
        return offer
    }

    public func price(_ offerId: String) async throws -> Price { try await offer(offerId).price }

    public func probe<Input: Encodable & Sendable>(
        _ offerId: String, input: Input, idempotencyKey: String? = nil, attribution: Attribution? = nil
    ) async throws -> (Data, HTTPURLResponse, Identity) {
        let offer = try await offer(offerId)
        let (body, identity) = try envelope(offer, input: input, idempotencyKey: idempotencyKey, attribution: attribution)
        let (data, response) = try await request(read, method: "POST", path: offer.route.path, body: body)
        return (data, response, identity)
    }

    public func invoke<Input: Encodable & Sendable>(
        _ offerId: String, input: Input, idempotencyKey: String? = nil,
        attribution: Attribution? = nil,
        beforePayment: (@Sendable (Identity) async throws -> Void)? = nil
    ) async throws -> InvocationResult {
        guard let payment else { throw AuscaError.invalid("payment authority is required for invoke") }
        let offer = try await offer(offerId)
        let (body, identity) = try envelope(offer, input: input, idempotencyKey: idempotencyKey, attribution: attribution)
        try await beforePayment?(identity)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await request(payment, method: "POST", path: offer.route.path, body: body)
        } catch { throw AuscaError.uncertain(identity) }
        guard (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) != nil else {
            throw AuscaError.uncertain(identity)
        }
        if response.statusCode >= 400 {
            throw AuscaError.refusal(status: response.statusCode, body: data, identity: identity)
        }
        return InvocationResult(status: response.statusCode, body: data, identity: identity)
    }

    public func invocation(_ invocationId: String) async throws -> Data {
        guard !invocationId.isEmpty else { throw AuscaError.invalid("invocation ID is required") }
        let path = "/v1/invocations/" + (invocationId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")
        let (data, response) = try await request(read, method: "GET", path: path)
        guard response.statusCode == 200 else { throw AuscaError.invalid("invocation read answered \(response.statusCode)") }
        return data
    }

    public func commit(_ bytes: Data, mediaType: String, idempotencyKey: String? = nil) async throws -> ArtifactCommitment {
        guard (1...Self.maxArtifactBytes).contains(bytes.count) else { throw AuscaError.invalid("artifact size exceeds platform ingress limit") }
        guard !mediaType.isEmpty, mediaType.utf8.count <= 200, mediaType == mediaType.trimmingCharacters(in: .whitespacesAndNewlines) else {
            throw AuscaError.invalid("invalid artifact media type")
        }
        let key = idempotencyKey ?? "ausca-artifact-\(UUID().uuidString.lowercased())"
        try validateKey(key)
        let digest = "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let body = try json(ArtifactUpload(dataBase64: bytes.base64EncodedString(), contentDigest: digest, mediaType: mediaType, idempotencyKey: key))
        let data: Data
        let response: HTTPURLResponse
        do { (data, response) = try await request(read, method: "POST", path: "/v1/artifacts", body: body) }
        catch { throw AuscaError.invalid("artifact commit uncertain; reuse key \(key)") }
        guard response.statusCode == 200 else { throw AuscaError.invalid("artifact ingress answered \(response.statusCode); reuse key \(key)") }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let result: ArtifactCommitResult
        do { result = try decoder.decode(ArtifactCommitResult.self, from: data) }
        catch { throw AuscaError.invalid("artifact commit uncertain; reuse key \(key)") }
        let artifact = result.artifact
        guard result.status == "stored", !artifact.artifactRef.isEmpty, artifact.artifactRef.utf8.count <= 512,
              artifact.contentDigest == digest, artifact.mediaType == mediaType, artifact.sizeBytes == bytes.count,
              !artifact.createdAt.isEmpty else { throw AuscaError.invalid("artifact ingress returned mismatched evidence; reuse key \(key)") }
        return ArtifactCommitment(artifactRef: artifact.artifactRef, contentDigest: digest, mediaType: mediaType)
    }

    public func access(_ artifactRef: String, idempotencyKey: String? = nil) async throws -> ArtifactAccess {
        guard !artifactRef.isEmpty, artifactRef.utf8.count <= 512 else { throw AuscaError.invalid("invalid artifact reference") }
        let key = idempotencyKey ?? "ausca-\(UUID().uuidString.lowercased())"
        try validateKey(key)
        let encoded = artifactRef.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let (data, response) = try await request(read, method: "POST", path: "/v1/artifacts/\(encoded)/access", headers: ["Idempotency-Key": key])
        guard response.statusCode == 200 else { throw AuscaError.invalid("artifact access answered \(response.statusCode)") }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let result = try decoder.decode(ArtifactAccessResult.self, from: data)
        guard result.status == "ready", result.artifact.artifactRef == artifactRef,
              !result.artifact.contentDigest.isEmpty, !result.artifact.downloadUrl.isEmpty,
              !result.artifact.expiresAt.isEmpty else { throw AuscaError.invalid("artifact access returned invalid evidence") }
        return result.artifact
    }

    private func envelope<Input: Encodable>(_ offer: Offer, input: Input, idempotencyKey: String?, attribution: Attribution?) throws -> (Data, Identity) {
        try validate(offer)
        let key = idempotencyKey ?? "ausca-\(UUID().uuidString.lowercased())"
        try validateKey(key)
        if let attribution {
            guard validLabel(attribution.source, max: 64), attribution.campaign.map({ validLabel($0, max: 128) }) ?? true else {
                throw AuscaError.invalid("attribution source and campaign must be bounded lowercase labels")
            }
        }
        let value = InvocationEnvelope(offerId: offer.offerId, offerRevision: offer.revision,
                                       offerRevisionDigest: offer.revisionDigest, inputSchemaDigest: offer.inputSchema.digest,
                                       outputSchemaDigest: offer.outputSchema.digest, input: input, idempotencyKey: key,
                                       attribution: attribution)
        return (try json(value), Identity(offerId: offer.offerId, idempotencyKey: key))
    }

    private func request(_ transport: any Transport, method: String, path: String, body: Data? = nil,
                         headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: serviceOrigin + path) else {
            throw AuscaError.invalid("invalid resource path")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return try await transport.send(request)
    }

    private func json<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    private func validate(_ offer: Offer) throws {
        guard !offer.offerId.isEmpty, !offer.revision.isEmpty, !offer.revisionDigest.isEmpty,
              !offer.inputSchema.digest.isEmpty, !offer.outputSchema.digest.isEmpty,
              offer.route.method == "POST", offer.route.path.hasPrefix("/v1/"),
              !offer.route.path.contains(".."), !offer.route.path.contains("?"), !offer.route.path.contains("#") else {
            throw AuscaError.invalid("invalid catalog binding for \(offer.offerId)")
        }
    }

    private func validateKey(_ key: String) throws {
        guard (16...128).contains(key.utf8.count), key == key.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw AuscaError.invalid("idempotency key must be 16 to 128 clean UTF-8 bytes")
        }
    }

    private func validLabel(_ value: String, max: Int) -> Bool {
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.count <= max, asciiAlnum(bytes[0]) else { return false }
        return bytes.allSatisfy { asciiAlnum($0) || [46, 95, 45].contains($0) }
    }

    private func asciiAlnum(_ byte: UInt8) -> Bool { (97...122).contains(byte) || (48...57).contains(byte) }
}

private struct CatalogDocument: Decodable { let offers: [Offer] }

private struct InvocationEnvelope<Input: Encodable>: Encodable {
    let offerId: String
    let offerRevision: String
    let offerRevisionDigest: String
    let inputSchemaDigest: String
    let outputSchemaDigest: String
    let input: Input
    let idempotencyKey: String
    let attribution: Attribution?
}

private struct ArtifactUpload: Encodable {
    let dataBase64: String
    let contentDigest: String
    let mediaType: String
    let idempotencyKey: String
}

private struct StoredArtifact: Decodable {
    let artifactRef: String
    let contentDigest: String
    let mediaType: String
    let sizeBytes: Int
    let createdAt: String
}

private struct ArtifactCommitResult: Decodable { let status: String; let artifact: StoredArtifact }
private struct ArtifactAccessResult: Decodable { let status: String; let artifact: ArtifactAccess }
