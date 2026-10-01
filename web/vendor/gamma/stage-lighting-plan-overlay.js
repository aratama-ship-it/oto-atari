// 複製元: show-creative-ideas/stage-sketch-gamma/stage-lighting-plan-overlay.js（2026-10-01 時点）。音アタリ側では編集しない。直すときは元を直してから再複製
/* Stage Sketch の劇場照明プランを、編集用の平面図へだけ重ねるための読取モデル。
 *
 * ここは project.lightingDesign を変更しない。全消灯の仮想仕込みを「既存照明と
 * 比べるための概略」として描くため、未解釈の cue / safety / 将来フィールドには
 * 触れず、rig.fixtures[].mount の安全に読める最小部分だけを返す。
 */
(function (root) {
  "use strict";

  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  const list = (value) => Array.isArray(value) ? value : [];

  function selectedPlan(rawStore, planId) {
    if (!record(rawStore) || !Array.isArray(rawStore.plans) || typeof planId !== "string" || !planId) return null;
    const plan = rawStore.plans.find((item) => record(item) && item.id === planId);
    if (!plan || !record(plan.design) || !record(plan.design.rig)) return null;
    return plan;
  }

  function normalisedTrusses(plan) {
    return list(plan && plan.design && plan.design.rig && plan.design.rig.trusses)
      .filter(record)
      .map((truss) => ({
        id: typeof truss.id === "string" ? truss.id : "",
        u0: 0,
        u1: 1,
        v: clamp(finite(truss.v, 0.5), 0, 1),
        h: Math.max(0, finite(truss.h, 0)),
      }))
      .filter((truss) => truss.id);
  }

  function markerForFixture(fixture, trusses, dims) {
    if (!record(fixture) || !record(fixture.mount)) return null;
    const mount = fixture.mount;
    const kind = fixture.kind === "laser" ? "laser" : fixture.kind === "moving" ? "moving" : "fixed";
    const marker = {
      id: typeof fixture.id === "string" ? fixture.id : "",
      kind,
      family: typeof fixture.family === "string" ? fixture.family : "",
      mountType: typeof mount.type === "string" ? mount.type : "",
      u: 0.5,
      v: 0.5,
      h: 0,
      outside: false,
      conceptual: true,
    };
    if (!marker.id) return null;
    if (mount.type === "truss") {
      const truss = trusses.find((item) => item.id === mount.trussId);
      if (!truss) return null;
      marker.u = clamp(finite(mount.u, 0.5), 0, 1);
      marker.v = truss.v;
      marker.h = truss.h;
    } else if (mount.type === "floor") {
      marker.u = clamp(finite(mount.u, 0.5), 0, 1);
      marker.v = clamp(finite(mount.v, 0.5), 0, 1);
      marker.h = 0;
    } else if (mount.type === "side") {
      marker.u = mount.side === "shimote" ? -0.04 : 1.04;
      marker.v = clamp(finite(mount.v, 0.5), 0, 1);
      marker.h = Math.max(0, finite(mount.h, 0));
      marker.outside = true;
    } else if (mount.type === "front") {
      marker.u = clamp(finite(mount.u, 0.5), 0, 1);
      marker.v = 1 + Math.max(0.5, finite(mount.ahead, 1)) / Math.max(1, finite(dims && dims.D, 1));
      marker.h = Math.max(0, finite(mount.h, 0));
      marker.outside = true;
    } else if (mount.type === "cyc") {
      marker.u = 0.5;
      marker.v = 0;
      marker.h = mount.rung === "top" ? Math.max(0, finite(dims && dims.H, 0)) : 0;
      marker.mountType = mount.rung === "top" ? "cyc-top" : "cyc-floor";
    } else if (mount.type === "legacy-panel") {
      /* 旧ベータからコピー変換した v2 は、仕込み分類へ推測で寄せず
         当時の任意座標を保持する。null が残る未設定灯は図へ出さない。 */
      if (![mount.u, mount.v, mount.h].every(Number.isFinite)) return null;
      marker.u = mount.u;
      marker.v = mount.v;
      marker.h = mount.h;
      marker.outside = mount.u < 0 || mount.u > 1 || mount.v < 0 || mount.v > 1
        || mount.h > Math.max(0, finite(dims && dims.H, 0));
    } else {
      return null;
    }
    return marker;
  }

  function overlayForPlan(plan) {
    if (!plan || !record(plan.design) || !record(plan.design.rig)) return null;
    const dims = record(plan.stageBasis && plan.stageBasis.dims) ? plan.stageBasis.dims
      : (record(plan.design.stage) ? plan.design.stage : {});
    const trusses = normalisedTrusses(plan);
    const markers = list(plan.design.rig.fixtures)
      .map((fixture) => markerForFixture(fixture, trusses, dims))
      .filter(Boolean);
    if (!markers.length) return null;
    return {
      id: plan.id,
      label: typeof plan.label === "string" ? plan.label : "劇場照明プラン",
      dims: { W: finite(dims.W, 0), D: finite(dims.D, 0), H: finite(dims.H, 0) },
      trusses,
      markers,
      counts: {
        total: markers.length,
        fixed: markers.filter((marker) => marker.kind === "fixed").length,
        moving: markers.filter((marker) => marker.kind === "moving").length,
        laser: markers.filter((marker) => marker.kind === "laser").length,
      },
    };
  }

  function matchesProject(plan, project, effectiveSize) {
    const basis = plan && plan.stageBasis;
    if (!record(basis) || !record(basis.dims) || !record(project)
        || project.venue !== basis.venueId || project.venueSize !== basis.venueSizeId) return false;
    const size = record(project.venueDims) ? project.venueDims : effectiveSize;
    if (!record(size)) return false;
    return [["W", "width"], ["D", "depth"], ["H", "height"]].every(([a, b]) =>
      typeof basis.dims[a] === "number" && Number.isFinite(basis.dims[a]) && basis.dims[a] > 0
      && typeof size[b] === "number" && Number.isFinite(size[b]) && Math.abs(basis.dims[a] - size[b]) < 0.01);
  }

  const api = Object.freeze({ selectedPlan, overlayForPlan, matchesProject });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SHOSAI_STAGE_LIGHTING_PLAN_OVERLAY = api;
})(typeof window !== "undefined" ? window : globalThis);
