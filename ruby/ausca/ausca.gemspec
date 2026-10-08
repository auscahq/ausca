# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = "ausca"
  spec.version = "0.2.0"
  spec.authors = ["Ausca"]
  spec.summary = "Rail-neutral client for Ausca's live pay-per-call catalog"
  spec.description = "Resolve active offers, bind paid invocations, recover uncertain calls, and handle artifacts without embedding payment credentials."
  spec.homepage = "https://ausca.com"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1"
  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]
  spec.metadata = {
    "homepage_uri" => "https://ausca.com",
    "source_uri" => "https://github.com/auscahq/ausca/tree/main/ruby/ausca",
    "bug_tracker_uri" => "https://github.com/auscahq/ausca/issues"
  }
end
