/**
 * steelStatistics.js — Volume, Weight, Area & Length Statistics with Grouping
 *
 * Computes per-object and grouped statistics for steel and all objects.
 * Integrates with objectExplorer for data and with excelExport for export.
 */

import { getAllObjects, getSelectedObjects, getSelectedIds } from "./objectExplorer.js";
import { exportToExcel } from "./excelExport.js";

// ── Constants ──
const STEEL_DENSITY = 7850; // kg/m³

// ── State ──
let apiRef = null;
let viewerRef = null;
let currentData = []; // cached stats data

// ── Init ──
export function initSteelStatistics(api, viewer) {
  apiRef = api;
  viewerRef = viewer;

  // Listen for data from objectExplorer
  window.addEventListener("objects-scanned", (e) => {
    updateStatistics();
  });

  // UI bindings
  document.getElementById("stats-group-by").addEventListener("change", updateStatistics);
  document.getElementById("stats-all-toggle").addEventListener("change", updateStatistics);
  document.getElementById("btn-export-all").addEventListener("click", () => exportExcel(false));
  document.getElementById("btn-export-selected").addEventListener("click", () => exportExcel(true));

  // Listen for real-time selection changes
  window.addEventListener("selection-changed", () => {
    updateStatistics();
  });
}

// ── Update Statistics ──
function updateStatistics() {
  const showAll = document.getElementById("stats-all-toggle").checked;
  const groupBy = document.getElementById("stats-group-by").value;

  // When "Toàn bộ dự án" is unchecked, show selected objects only
  const selIds = getSelectedIds();
  let objects;
  if (showAll) {
    objects = getAllObjects();
  } else {
    objects = getSelectedObjects(); // returns [] if nothing selected
  }
  if (!objects || objects.length === 0) {
    clearStats();
    return;
  }

  // Calculate totals
  let totalVolume = 0;
  let totalWeight = 0;
  let totalArea = 0;
  let totalLength = 0;

  const enriched = objects.map((obj) => {
    let vol = obj.volume || 0;
    let wt = obj.weight || 0;
    let area = obj.area || 0;
    let len = obj.length || 0;

    // If weight is 0 but volume exists, calculate from density
    if (wt === 0 && vol > 0) {
      wt = vol * STEEL_DENSITY;
    }

    totalVolume += vol;
    totalWeight += wt;
    totalArea += area;
    totalLength += len;

    return { ...obj, volume: vol, weight: wt, area, length: len };
  });

  currentData = enriched;

  // Update summary cards
  document.getElementById("stat-total-objects").textContent = formatNumber(objects.length);
  document.getElementById("stat-total-volume").textContent = formatVolume(totalVolume);
  document.getElementById("stat-total-weight").textContent = formatWeight(totalWeight);
  document.getElementById("stat-total-area").textContent = formatArea(totalArea);
  document.getElementById("stat-total-length").textContent = formatLength(totalLength);

  // Group data
  const groups = {};
  for (const obj of enriched) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { name: key, count: 0, volume: 0, weight: 0, area: 0, length: 0 };
    }
    groups[key].count++;
    groups[key].volume += obj.volume;
    groups[key].weight += obj.weight;
    groups[key].area += obj.area;
    groups[key].length += obj.length;
  }

  const sortedGroups = Object.values(groups).sort((a, b) => b.weight - a.weight);

  document.getElementById("stat-total-groups").textContent = formatNumber(sortedGroups.length);

  // Render table
  renderStatsTable(sortedGroups, totalVolume, totalWeight, totalArea, totalLength);

  // Hide placeholder
  document.getElementById("stats-placeholder").style.display = "none";
}

// ── Render Table ──
function renderStatsTable(groups, totalVolume, totalWeight, totalArea, totalLength) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  let bodyHtml = "";
  for (const g of groups) {
    bodyHtml += `<tr>`;
    bodyHtml += `<td>${escHtml(g.name)}</td>`;
    bodyHtml += `<td>${formatNumber(g.count)}</td>`;
    bodyHtml += `<td>${formatVolume(g.volume)}</td>`;
    bodyHtml += `<td>${formatArea(g.area)}</td>`;
    bodyHtml += `<td>${formatLength(g.length)}</td>`;
    bodyHtml += `<td>${formatWeight(g.weight)}</td>`;
    bodyHtml += `</tr>`;
  }
  tbody.innerHTML = bodyHtml;

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(groups.reduce((s, g) => s + g.count, 0))}</td>
      <td>${formatVolume(totalVolume)}</td>
      <td>${formatArea(totalArea)}</td>
      <td>${formatLength(totalLength)}</td>
      <td>${formatWeight(totalWeight)}</td>
    </tr>
  `;
}

// ── Export Excel ──
function exportExcel(selectedOnly) {
  const groupBy = document.getElementById("stats-group-by").value;
  const data = selectedOnly ? getSelectedObjects() : getAllObjects();

  if (!data || data.length === 0) {
    console.warn("[Statistics] No data to export");
    return;
  }

  // Prepare export data
  const enrichedData = data.map((obj) => ({
    ...obj,
    weight: obj.weight || (obj.volume > 0 ? obj.volume * STEEL_DENSITY : 0),
  }));

  exportToExcel(enrichedData, groupBy, selectedOnly);
}

// ── Helpers ──
function getGroupKey(obj, groupBy) {
  switch (groupBy) {
    case "assembly": return obj.assembly;
    case "name": return obj.name;
    case "group": return obj.group;
    case "material": return obj.material;
    default: return obj.assembly;
  }
}

function clearStats() {
  document.getElementById("stat-total-objects").textContent = "0";
  document.getElementById("stat-total-volume").textContent = "0 m³";
  document.getElementById("stat-total-weight").textContent = "0 kg";
  document.getElementById("stat-total-area").textContent = "0 m²";
  document.getElementById("stat-total-length").textContent = "0 m";
  document.getElementById("stat-total-groups").textContent = "0";
  document.getElementById("stats-table-body").innerHTML = "";
  document.getElementById("stats-table-footer").innerHTML = "";
  document.getElementById("stats-placeholder").style.display = "flex";
}

function formatNumber(n) {
  return n.toLocaleString("vi-VN");
}

function formatVolume(v) {
  return v.toFixed(6) + " m³";
}

function formatArea(a) {
  return a.toFixed(4) + " m²";
}

function formatLength(l) {
  if (l >= 1000) return (l / 1000).toFixed(3) + " km";
  return l.toFixed(3) + " m";
}

function formatWeight(w) {
  if (w >= 1000) return (w / 1000).toFixed(2) + " tấn";
  return w.toFixed(2) + " kg";
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
