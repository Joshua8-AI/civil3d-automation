# Testing record

How the bridge is verified, and the last recorded results (2026-09-26, `main`, Node 24.19.0, Windows 11).

## Offline (neither app running)

| check | command | last result |
|---|---|---|
| Type check + build | `npm run build` | 0 errors |
| All tests | `npm test` | 10 files, 138 tests passed (~2 s; 126 → 135 with the getDrawingUnits/getParcelGeometry adapter tests → 138 with the live-run regressions, 2026-09-26) |
| stdio smoke | pipe `initialize` + `tools/list` into `node build/index.js` | server info `civil3d-revit-bridge 0.1.0`; the 5 tools listed |
| Graceful failure | `tools/call bridge_status` with both apps closed | `ok:false`; both plugins reported `ECONNREFUSED`; Revit port 8081 found from `%APPDATA%\...\Addins\2027\revit_mcp_plugin\mcp-port.txt` |

### What the suites cover

| file | kind | covers |
|---|---|---|
| `tests/units.test.ts` | known-answer + property | exact ft / US survey ft / m / in factors; the 3.66 m survey-foot difference at E=6,000,000 ft; mm round trips for every unit; unit resolution, the ambiguity warning, overrides, refusal of unknown units; the plugin's `getDrawingUnits.lengthUnit` mapping (`USSurveyFeet` vs `Feet`, no ambiguity warning, plugin warnings passed through) |
| `tests/transform.test.ts` | known-answer + property (fast-check, several hundred runs each) | translation, ±90° rotations, anchoring at a non-origin internal point, state-plane conversion; internal↔shared inverse both ways; rigidity (distances preserved); re-anchoring; civil→internal→civil through a computed position; two-point rotation recovers a known angle with scale ratio 1; angle normalisation; detecting an opposite rotation sign |
| `tests/geometry.test.ts` | known-answer + property | point in polygon, segment/polygon distance, containment, perimeter densification; grid planning never exceeds `maxPoints` (this found an out-of-memory bug with tiny spacings on thin regions, now fixed with an analytic pre-coarsen); decimation stays within budget, returns a subset of the input and keeps the extent |
| `tests/previewStore.test.ts` | unit | canonical hashing; single use; bound to arguments, payload and tool; expiry |
| `tests/clients.test.ts` | **real loopback TCP fakes** | Civil 3D framing (bare JSON, never half-closes before the reply, a reply split into ~1 KB chunks), error envelope → domain code, `METHOD_NOT_FOUND`, id mismatch, timeout, refused connection, early close, size cap, read-only allow-list refused before connecting. Revit framing (NDJSON, split lines, blank lines), AIResult unwrapping in both casings, `Success:false`, method not found, timeout, calls serialised with no overlap, recovery after a failure. Port discovery: newest valid `mcp-port.txt`, rejection of garbage and out-of-range ports, 8080 fallback, `REVIT_MCP_PORT` |
| `tests/tools.align.test.ts` | tool logic with in-memory fakes | the default preview writes nothing; apply needs a `previewId`, which is single-use and bound to the arguments; apply is refused if the Civil 3D point moved; verification after apply; explicit angle with a non-origin internal point; an opposite-sign Revit plugin is detected with a hint; two-point rotation; a unit-mismatch refusal; the US survey foot override; Revit without the pending commands |
| `tests/tools.toposolid.test.ts` | tool logic | grid inside the boundary, exact z conversion, dry run only; apply sends exactly the previewed payload; blocked when not aligned (>32 km); bounding-box default; boundary given in `revitInternal`; missing `tin` command explained; TIN decimation; refused if the surface changed; too few points |
| `tests/tools.utilities.test.ts` | tool logic | selection by distance from the footprint and by boundary; orphan pipe skipped; inverts from centreline − D/2; connection points; network filter; create preview/apply with regex and kind mapping; `levelName` required; unmapped pipes blocked; `diameterUnits`, and the heuristic warning when feet diameters look like inches |
| `tests/tools.consistency-status.test.ts` | tool logic | FFE pass, fail and too-high; multiple pads; setbacks from `reportParcels`, per-edge overrides, footprint outside the parcel, plugin with no vertices; alignment via the survey point and via an internal point; Revit unreachable → `incomplete`; status: all fields, pending probes, unreachable apps, Revit without the pending commands; with the new Civil 3D commands present: units from `getDrawingUnits` (US survey feet, plugin warnings, override), probes report `available`, setbacks from `getParcelGeometry` |
| `tests/e2e.mcp.test.ts` | **end to end** | MCP `Client` → `McpServer` (in-memory transport) → the real `Civil3DClient` and `RevitClient` → loopback TCP fakes: tool list and annotations; `bridge_status`; align preview → apply → toposolid preview → apply; apply without a preview is an MCP error with no write; schema validation; Civil 3D is never written |

The fakes (`tests/helpers/fakes.ts`) model Revit shared coordinates with the bridge's rotation
convention. They can also flip the sign (`angleSign = -1`) or drop the pending commands
(`implementsPending = false`).

## Live (Civil 3D and Revit open)

Run 2026-09-26 against Civil 3D 2027 (plugin from Civil3D-mcp `civil3d-2027-support` @ `35b5600`,
tutorial drawing `Pipe Networks-3.dwg`: feet, no CRS, EG TIN surface, one gravity network of 11
pipes / 12 structures) and Revit 2027.2 (add-in from revit-mcp-server `joshua8-main` @ `f6c3058`,
scratch copy of `Snowdon Towers Sample Plumbing.rvt`). Driven over real MCP stdio; each preview and
its apply in one server session (previews are per session by design).

| tool | result |
|---|---|
| `bridge_status` | 210 ms; both apps; feet from `getDrawingUnits`; `getSurfaceTinVertices`, `getParcelGeometry`, `getDrawingUnits` all `available` |
| `bridge_align_coordinates` explicit point (Structure (1) rim) → Revit internal origin, 0° | preview 1.0 s, apply 1.1 s; `verification.pass`, max delta 0.0004 mm; Revit's "survey point is outside the current coordinate reference system" warning returned in the result (no dialog) |
| same at **30°** | `verification.pass`, offset test point round-trips to 1e-10 mm, Revit reports `angleToTrueNorth_deg: 30` — **rotation sign confirmed** |
| `bridge_surface_to_toposolid` `sampling: "tin"`, 200 × 200 ft boundary | 4 TIN vertices in the window (coarse EG); toposolid committed |
| `bridge_surface_to_toposolid` `sampling: "grid"`, 10 ft | **bug:** boundary corners duplicated grid nodes, Revit rejected the dry run, yet the preview issued a `previewId`. Fixed in `0821c30` (dedupe + rejected dry run blocks). After: 403 points, ±30,480 mm extent, applied in 0.2 s; "toposolids overlap" returned in `warnings` |
| `bridge_utilities_to_revit` `mode: "report"` | 11 pipes, `geometrySource: pipe startPoint/endPoint`, 18" = 457.2 mm, inverts = centreline − D/2 |
| `bridge_utilities_to_revit` `mode: "create"` (Sanitary, L1 - Block 43) | 11 Revit pipes; the first starts at internal (0, 0, −1206.5) mm = Structure (1) centreline 3.958 ft below the rim base point |
| `bridge_check_consistency` (footprint, FFE vs EG, alignment) | 79 ms; alignment `pass` (0 ft); FFE `fail` (level 651.894 ft vs grade up to 653.091 ft) — correct for this arbitrary layout |

Not exercised live: `sampling: "tin"` on a dense surface, setbacks from real parcels (Pipe Networks-3
has none; `getParcelGeometry` itself was checked on Pipe Networks-1A — outer loop only for parcels
with holes), `twoPoints` rotation, `civil3dNorth` rotation on a drawing with a CRS, US survey feet.
