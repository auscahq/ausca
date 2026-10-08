import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import Ausca

private let catalogJSON = """
{"offers":[{"offer_id":"browser.session","title":"Browser","description":"Session","revision":"r1","revision_digest":"sha256:revision","input_schema":{"digest":"sha256:input","public_path":"/input.json"},"output_schema":{"digest":"sha256:output","public_path":"/output.json"},"route":{"method":"POST","path":"/v1/lease-browser"},"price":{"currency":"USD","model":"input_choice","minimum_minor":5,"maximum_minor":20,"policy_digest":"sha256:price"}}]}
"""

private func answer(_ request: URLRequest, status: Int, body: String) -> (Data, HTTPURLResponse) {
    (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: [:])!)
}

private struct FakeTransport: Transport {
    let handler: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { try await handler(request) }
}

private actor Recorder {
    var bodies: [Data] = []
    var identity: Identity?
    func record(_ request: URLRequest) { bodies.append(request.httpBody ?? Data()) }
    func retain(_ value: Identity) { identity = value }
    func snapshot() -> ([Data], Identity?) { (bodies, identity) }
}

final class AuscaTests: XCTestCase {
    private func catalogRead() -> FakeTransport {
        FakeTransport { request in
            if request.url!.path == "/catalog.json" { return answer(request, status: 200, body: catalogJSON) }
            return answer(request, status: 402, body: "{\"accepts\":[]}")
        }
    }

    func testPaymentIdentityAndExactRetryBytes() async throws {
        let recorder = Recorder()
        let payment = FakeTransport { request in
            await recorder.record(request)
            return answer(request, status: 200, body: "{\"status\":\"succeeded\",\"receipt_ref\":{\"public_url\":\"https://runx.ai/r/test\"}}")
        }
        let client = AuscaClient(payment: payment, origin: "https://example.com", read: catalogRead())
        let first = try await client.invoke("browser.session", input: ["duration_seconds": 600], idempotencyKey: "browser-purchase-0001", beforePayment: { value in
            await recorder.retain(value)
        })
        _ = try await client.invoke("browser.session", input: ["duration_seconds": 600], idempotencyKey: "browser-purchase-0001")
        let (bodies, retained) = await recorder.snapshot()
        XCTAssertEqual(first.identity, retained)
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies[0], bodies[1])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any])
        XCTAssertEqual(body["offer_revision_digest"] as? String, "sha256:revision")
    }

    func testProbeDoesNotPay() async throws {
        let payment = FakeTransport { _ in throw AuscaError.invalid("probe used payment") }
        let client = AuscaClient(payment: payment, origin: "https://example.com", read: catalogRead())
        let (_, response, identity) = try await client.probe("browser.session", input: ["duration_seconds": 600], idempotencyKey: "browser-purchase-0001")
        XCTAssertEqual(response.statusCode, 402)
        XCTAssertEqual(identity.idempotencyKey, "browser-purchase-0001")
    }

    func testUncertainOutcomeRetainsIdentity() async throws {
        let payment = FakeTransport { _ in throw AuscaError.invalid("closed after send") }
        let client = AuscaClient(payment: payment, origin: "https://example.com", read: catalogRead())
        do {
            _ = try await client.invoke("browser.session", input: [String: Int](), idempotencyKey: "browser-purchase-0001")
            XCTFail("expected uncertainty")
        } catch AuscaError.uncertain(let identity) {
            XCTAssertEqual(identity.idempotencyKey, "browser-purchase-0001")
        }
    }

    func testArtifactCommitAndBodylessAccess() async throws {
        let read = FakeTransport { request in
            if request.url!.path == "/v1/artifacts" {
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
                XCTAssertEqual(body["data_base64"] as? String, "dGVzdCBieXRlcw==")
                XCTAssertEqual(body["idempotency_key"] as? String, "artifact-upload-0001")
                let response: [String: Any] = ["status": "stored", "artifact": [
                    "artifact_ref": "art_1", "content_digest": body["content_digest"]!,
                    "media_type": "text/plain", "size_bytes": 10, "created_at": "now"
                ]]
                let data = try JSONSerialization.data(withJSONObject: response)
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
            }
            if request.url!.path == "/v1/artifacts/art_1/access" {
                XCTAssertNil(request.httpBody)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "artifact-access-0001")
                return answer(request, status: 200, body: "{\"status\":\"ready\",\"artifact\":{\"artifact_ref\":\"art_1\",\"content_digest\":\"sha256:test\",\"media_type\":\"text/plain\",\"size_bytes\":10,\"created_at\":\"now\",\"download_url\":\"https://example.com/download\",\"expires_at\":\"later\"}}")
            }
            return answer(request, status: 404, body: "{}")
        }
        let client = AuscaClient(origin: "https://example.com", read: read)
        let commitment = try await client.commit(Data("test bytes".utf8), mediaType: "text/plain", idempotencyKey: "artifact-upload-0001")
        XCTAssertEqual(commitment.artifactRef, "art_1")
        let access = try await client.access("art_1", idempotencyKey: "artifact-access-0001")
        XCTAssertEqual(access.downloadUrl, "https://example.com/download")
    }

    func testLiveCatalogWhenRequested() async throws {
        guard ProcessInfo.processInfo.environment["AUSCA_LIVE_TEST"] == "1" else { return }
        let client = AuscaClient()
        let offers = try await client.catalog()
        XCTAssertFalse(offers.isEmpty)
    }
}
