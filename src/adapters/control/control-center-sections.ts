import type { ContentQueueItem } from "../../application/control-center-content.js";
import type { IncidentView, ActivityRecord } from "../../application/control-center-operator-surfaces.js";
import type { RouteTestMatrix } from "../../application/route-test-matrix.js";

function esc(value: string): string { return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }

export function renderContentSection(items: readonly ContentQueueItem[]): string {
  const rows = items.map((item) => `<tr><td><strong>${esc(item.filename)}</strong><br><code>${esc(item.assetId)}</code></td><td>${esc(item.laneName)}<br><small>${esc(item.sourcePath)}</small></td><td>${esc(item.status)}</td><td>${item.routeIds.map(esc).join("<br>") || "—"}</td><td>${item.targetAccountIds.map((x)=>`<code>${esc(x)}</code>`).join(" ") || "—"}</td><td><a href="${esc(item.deepLink)}">Details</a></td></tr>`).join("");
  return `<section><h1>Content</h1><p>Datei-Lifecycle, Plan, Backlog und DeliveryAggregate in einer Sicht.</p><table><tr><th>Asset</th><th>Lane</th><th>Status</th><th>Routes</th><th>Targets</th><th></th></tr>${rows || "<tr><td colspan=6>Kein Content.</td></tr>"}</table></section>`;
}

export function renderRouteTestLabSection(matrices: readonly RouteTestMatrix[]): string {
  const blocks = matrices.map((matrix) => `<article><h2>${esc(matrix.routeName)} · ${esc(matrix.account)} <small>${esc(matrix.overall)}</small></h2><table><tr><th>Test</th><th>Risiko</th><th>Status</th><th>Detail</th></tr>${matrix.cases.map((item)=>`<tr><td>${esc(item.label)}</td><td>${esc(item.risk)}</td><td>${esc(item.status)}</td><td>${esc(item.detail)}</td></tr>`).join("")}</table></article>`).join("");
  return `<section><h1>Test Lab</h1><p>Tests entstehen aus den tatsächlich konfigurierten Routes und Posting Profiles.</p>${blocks || "<p>Keine Route konfiguriert.</p>"}</section>`;
}

export function renderIncidentsSection(incidents: readonly IncidentView[]): string {
  const blocks = incidents.map((item) => `<article><h2>${esc(item.severity)} · ${esc(item.title)}</h2><p>${esc(item.summary)}</p><p><strong>Impact:</strong> ${esc(item.impact)}</p>${item.prohibitedAction?`<p><strong>Nicht erlaubt:</strong> ${esc(item.prohibitedAction)}</p>`:""}<p>Erlaubte Aktionen: ${item.allowedActions.map((a)=>`<code>${esc(a)}</code>`).join(" ")}</p><a href="${esc(item.deepLink)}">Incident öffnen</a></article>`).join("");
  return `<section><h1>Incidents</h1>${blocks || "<p>Keine offenen Incidents.</p>"}</section>`;
}

export function renderActivitySection(records: readonly ActivityRecord[]): string {
  const rows = records.map((item)=>`<tr><td>${esc(item.occurredAt)}</td><td>${esc(item.kind)}</td><td><strong>${esc(item.title)}</strong><br><small>${esc(item.summary)}</small></td><td>${item.deepLink?`<a href="${esc(item.deepLink)}">Öffnen</a>`:"—"}</td></tr>`).join("");
  return `<section><h1>Activity</h1><table><tr><th>Zeit</th><th>Typ</th><th>Event</th><th></th></tr>${rows || "<tr><td colspan=4>Keine Activity.</td></tr>"}</table></section>`;
}
