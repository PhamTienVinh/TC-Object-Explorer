/**
 * excelExport.js — Export IFC object data to Excel (.xlsx)
 *
 * Uses SheetJS (xlsx) to generate multi-sheet workbooks with:
 * - Summary sheet: grouped totals
 * - Detail sheet: all object records
 */

import * as XLSX from "xlsx";

/**
 * Export data to Excel file.
 * @param {Array} data - Array of object records
 * @param {string} groupBy - "assembly" | "name" | "group" | "material"
 * @param {boolean} selectedOnly - Whether exporting only selected items
 */
export function exportToExcel(data, groupBy, selectedOnly) {
  if (!data || data.length === 0) {
    console.warn("[ExcelExport] No data to export");
    return;
  }

  const wb = XLSX.utils.book_new();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString("vi-VN");

  // ── Sheet 1: Summary (Grouped) ──
  const groups = {};
  for (const obj of data) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { count: 0, volume: 0, weight: 0, area: 0 };
    }
    groups[key].count++;
    groups[key].volume += obj.volume || 0;
    groups[key].weight += obj.weight || 0;
    groups[key].area += obj.area || 0;
  }

  const summaryHeader = [
    ["BÁO CÁO THỐNG KÊ ĐỐI TƯỢNG IFC"],
    [`Ngày xuất: ${dateStr} ${timeStr}`],
    [`Chế độ: ${selectedOnly ? "Đã chọn" : "Toàn bộ dự án"}`],
    [`Nhóm theo: ${getGroupLabel(groupBy)}`],
    [`Tổng số đối tượng: ${data.length}`],
    [],
    [getGroupLabel(groupBy), "Số lượng", "Thể tích (m³)", "Diện tích (m²)", "Khối lượng (kg)"],
  ];

  let totalVolume = 0;
  let totalWeight = 0;
  let totalArea = 0;
  const summaryRows = [];
  const sortedKeys = Object.keys(groups).sort();

  for (const key of sortedKeys) {
    const g = groups[key];
    totalVolume += g.volume;
    totalWeight += g.weight;
    totalArea += (g.area || 0);
    summaryRows.push([key, g.count, roundNum(g.volume, 6), roundNum(g.area || 0, 4), roundNum(g.weight, 2)]);
  }

  summaryRows.push([]);
  summaryRows.push(["TỔNG CỘNG", data.length, roundNum(totalVolume, 6), roundNum(totalArea, 4), roundNum(totalWeight, 2)]);

  const summaryData = [...summaryHeader, ...summaryRows];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);

  // Set column widths
  wsSummary["!cols"] = [
    { wch: 35 },
    { wch: 12 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
  ];

  // Merge title cell
  wsSummary["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
  ];

  XLSX.utils.book_append_sheet(wb, wsSummary, "Tổng hợp");

  // ── Sheet 2: Detail ──
  const detailHeader = [
    ["CHI TIẾT ĐỐI TƯỢNG IFC"],
    [`Ngày xuất: ${dateStr}`],
    [],
    ["STT", "Tên", "Profile", "Assembly", "Group", "Loại (IFC Type)", "Vật liệu", "Thể tích (m³)", "Diện tích (m²)", "Khối lượng (kg)"],
  ];

  const detailRows = data.map((obj, idx) => [
    idx + 1,
    obj.name || "",
    obj.profile || "",
    obj.assembly || "",
    obj.group || "",
    obj.type || "",
    obj.material || "",
    roundNum(obj.volume || 0, 6),
    roundNum(obj.area || 0, 4),
    roundNum(obj.weight || 0, 2),
  ]);

  // Add totals row
  detailRows.push([]);
  detailRows.push([
    "",
    "TỔNG CỘNG",
    "",
    "",
    "",
    "",
    "",
    roundNum(totalVolume, 6),
    roundNum(totalArea, 4),
    roundNum(totalWeight, 2),
  ]);

  const detailData = [...detailHeader, ...detailRows];
  const wsDetail = XLSX.utils.aoa_to_sheet(detailData);

  wsDetail["!cols"] = [
    { wch: 6 },
    { wch: 30 },
    { wch: 20 },
    { wch: 20 },
    { wch: 20 },
    { wch: 20 },
    { wch: 15 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
  ];

  wsDetail["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
  ];

  XLSX.utils.book_append_sheet(wb, wsDetail, "Chi tiết");

  // ── Sheet 3: By Assembly ── (if groupBy is not already assembly)
  if (groupBy !== "assembly") {
    const assemblySheet = createGroupSheet(data, "assembly", "Assembly");
    XLSX.utils.book_append_sheet(wb, assemblySheet, "Theo Assembly");
  }

  // ── Download ──
  const filename = `TC_IFC_Report_${dateStr}${selectedOnly ? "_selected" : ""}.xlsx`;
  XLSX.writeFile(wb, filename);
  console.log(`[ExcelExport] Exported ${data.length} records to ${filename}`);
}

// ── Helper: Create a grouped sheet ──
function createGroupSheet(data, groupBy, label) {
  const groups = {};
  for (const obj of data) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { count: 0, volume: 0, weight: 0, area: 0, items: [] };
    }
    groups[key].count++;
    groups[key].volume += obj.volume || 0;
    groups[key].weight += obj.weight || 0;
    groups[key].area += obj.area || 0;
    groups[key].items.push(obj);
  }

  const rows = [
    [`THỐNG KÊ THEO ${label.toUpperCase()}`],
    [],
    [label, "Số lượng", "Thể tích (m³)", "Diện tích (m²)", "Khối lượng (kg)"],
  ];

  let totalVol = 0;
  let totalWt = 0;
  let totalArea = 0;

  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    totalVol += g.volume;
    totalWt += g.weight;
    totalArea += (g.area || 0);
    rows.push([key, g.count, roundNum(g.volume, 6), roundNum(g.area || 0, 4), roundNum(g.weight, 2)]);
  }

  rows.push([]);
  rows.push(["TỔNG CỘNG", data.length, roundNum(totalVol, 6), roundNum(totalArea, 4), roundNum(totalWt, 2)]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 35 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
  return ws;
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

function getGroupLabel(groupBy) {
  switch (groupBy) {
    case "assembly": return "Assembly";
    case "name": return "Tên";
    case "group": return "Group";
    case "material": return "Vật liệu";
    default: return groupBy;
  }
}

function roundNum(n, decimals) {
  return Number(n.toFixed(decimals));
}
