import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// One name for a proxy on the phone card, in the Proxy route dropdown and on the Proxies tab.
const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../../client/deviceCardModel.js", import.meta.url), "utf8"), context);
const { proxyName, providerName, egressLabel } = context.window.deviceCardModel;
const app = fs.readFileSync(new URL("../../../client/app.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(new URL("../../../client/proxyPoolController.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../../../client/index.html", import.meta.url), "utf8");

test("the recording's proxies read 'US 1 (Oxylabs)' and 'US 3 (Oxylabs)', with nothing repeated", () => {
  assert.equal(egressLabel({ poolProxy: { country: "US", label: "US 1", provider: "oxylabs" }, network: {} }), "US 1 (Oxylabs)");
  assert.equal(egressLabel({ poolProxy: { country: "US", label: "US 3", provider: "Oxylabs.io" }, network: {} }), "US 3 (Oxylabs)");
});

test("the country is added only when the label does not already say it", () => {
  assert.equal(proxyName({ country: "US", label: "US 1" }), "US 1");
  assert.equal(proxyName({ country: "US", label: "USA 1" }), "USA 1");
  assert.equal(proxyName({ country: "US", label: "United States 1" }), "United States 1");
  assert.equal(proxyName({ country: "IT", label: "Italy" }), "Italy");
  assert.equal(proxyName({ country: "DE", label: "Premium 1" }), "DE Premium 1");
  assert.equal(proxyName({ country: "US", label: "1" }), "US 1");
  assert.equal(proxyName({ country: "us", label: "us pool 2" }), "us pool 2");
  assert.equal(proxyName({ country: "US", label: "" }), "US");
  assert.equal(proxyName({ country: "", label: "Spare" }), "Spare");
  assert.equal(proxyName({ country: "GB", label: "Edge GB-4" }), "Edge GB-4");
});

test("a provider shows one spelling, with or without a domain ending and whatever the registry says", () => {
  assert.equal(providerName("oxylabs"), "Oxylabs");
  assert.equal(providerName("Oxylabs.io"), "Oxylabs");
  assert.equal(providerName("OXYLABS.COM"), "OXYLABS", "typed capitals are kept");
  assert.equal(providerName("OxyLabs"), "OxyLabs");
  assert.equal(providerName("  smartproxy  "), "Smartproxy");
  assert.equal(providerName(""), "");
  assert.equal(providerName(null), "");
  const known = new Map([["oxylabs", "Oxylabs Ltd"]]);
  assert.equal(providerName("oxylabs", known), "Oxylabs Ltd");
  assert.equal(providerName("Oxylabs.io", known), "Oxylabs Ltd");
  assert.equal(providerName("other", known), "Other");
});

test("two proxies of one provider show the same provider spelling side by side", () => {
  const first = egressLabel({ poolProxy: { country: "US", label: "US 1", provider: "oxylabs" }, network: {} });
  const second = egressLabel({ poolProxy: { country: "US", label: "US 3", provider: "Oxylabs.io" }, network: {} });
  assert.equal(first.replace("US 1", ""), second.replace("US 3", ""));
});

test("no provider and no label are handled", () => {
  assert.equal(egressLabel({ poolProxy: { country: "US", label: "US 2", provider: "" }, network: {} }), "US 2");
  assert.equal(egressLabel({ poolProxy: { country: "US", label: "", provider: "oxylabs" }, network: {} }), "US (Oxylabs)");
});

test("the card keeps its other egress rules", () => {
  assert.equal(egressLabel({ poolProxy: null, network: {} }), "No egress assigned");
  assert.equal(egressLabel({ poolProxy: null, network: { providerLabel: "Home gateway" } }), "Home gateway");
  assert.equal(egressLabel({ poolProxy: { country: "US", label: "US 1", provider: "x" }, network: {} }, { proxyDisabled: true }), "Proxy disabled");
});

test("the card passes the provider registry so its spelling matches the Proxies tab", () => {
  assert.match(app, /deviceCardModel\.egressLabel\(d, \{ proxyDisabled, knownProviders: proxyPoolController\.getProviderLabels\(\) \}\)/);
});

test("the Proxy route dropdown uses the same name and provider as the card and the Proxies tab", () => {
  assert.match(app, /const option = new Option\(`\$\{proxy\.flag \? `\$\{proxy\.flag\} ` : ""\}\$\{deviceCardModel\.proxyName\(proxy\)\} · \$\{deviceCardModel\.providerName\(proxy\.provider, proxyPoolController\.getProviderLabels\(\)\)\}`, proxy\.id\);/);
  assert.match(controllerSource, /root\.deviceCardModel\.proxyName\(proxy\)/);
  assert.match(controllerSource, /root\.deviceCardModel\.providerName\(proxy\.provider, providerLabels\)/);
});

test("the page loads the shared names before the controller that uses them", () => {
  assert.ok(indexHtml.indexOf("deviceCardModel.js") < indexHtml.indexOf("proxyPoolController.js"));
});
