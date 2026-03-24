/**
 * excelExport.js — Export IFC object data to Excel (.xlsx)
 *
 * Multi-sheet workbook with:
 * - Tổng hợp: grouped summary by current filter
 * - Chi tiết: all object records with full columns
 * - Theo Assembly Pos: grouped by ASSEMBLY_POS
 * - Theo Assembly Name: grouped by ASSEMBLY_NAME
 * - Theo Object Type: grouped by object type
 * - Theo Vật liệu: grouped by material
 */

import * as XLSX from "xlsx";

/**
 * Export data to Excel file.
 * @param {Array} data - Array of object records
 * @param {string} groupBy - current grouping key
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

  // ── Sheet 1: Summary (Grouped by current filter) ──
  const groups = {};
  for (const obj of data) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { count: 0, volume: 0, weight: 0, area: 0, length: 0 };
    }
    groups[key].count++;
    groups[key].volume += obj.volume || 0;
    groups[key].weight += obj.weight || 0;
    groups[key].area += obj.area || 0;
    groups[key].length += obj.length || 0;
  }

  const summaryHeader = [
    ["BÁO CÁO THỐNG KÊ ĐỐI TƯỢNG IFC"],
    [`Ngày xuất: ${dateStr} ${timeStr}`],
    [`Chế độ: ${selectedOnly ? "Đã chọn" : "Toàn bộ dự án"}`],
    [`Nhóm theo: ${getGroupLabel(groupBy)}`],
    [`Tổng số đối tượng: ${data.length}`],
    [],
    [getGroupLabel(groupBy), "Số lượng", "Thể tích (m³)", "Diện tích (m²)", "Khối lượng (kg)", "Chiều dài (m)"],
  ];

  let totalVolume = 0, totalWeight = 0, totalArea = 0, totalLength = 0;
  const summaryRows = [];

  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    totalVolume += g.volume;
    totalWeight += g.weight;
    totalArea += g.area;
    totalLength += g.length;
    summaryRows.push([key, g.count, r(g.volume, 6), r(g.area, 4), r(g.weight, 2), r(g.length, 3)]);
  }
  summaryRows.push([]);
  summaryRows.push(["TỔNG CỘNG", data.length, r(totalVolume, 6), r(totalArea, 4), r(totalWeight, 2), r(totalLength, 3)]);

  const wsSummary = XLSX.utils.aoa_to_sheet([...summaryHeader, ...summaryRows]);
  wsSummary["!cols"] = [{ wch: 35 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 15 }];
  wsSummary["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Tổng hợp");

  // ── Sheet 2: Detail (full columns) ──
  const detailHeader = [
    ["CHI TIẾT ĐỐI TƯỢNG IFC"],
    [`Ngày xuất: ${dateStr} | ${selectedOnly ? "Đã chọn" : "Toàn bộ"} | ${data.length} đối tượng`],
    [],
    [
      "STT", "Tên", "Profile", "IFC Class", "Object Type",
      "Assembly Pos", "Assembly Name", "Assembly Code",
      "Group", "Vật liệu",
      "Thể tích (m³)", "Diện tích (m²)", "Khối lượng (kg)", "Chiều dài (m)",
    ],
  ];

  const detailRows = data.map((obj, idx) => [
    idx + 1,
    obj.name || "",
    obj.profile || "",
    obj.ifcClass || "",
    obj.type || "",
    obj.assemblyPos || "",
    obj.assemblyName || "",
    obj.assemblyPosCode || "",
    obj.group || "",
    obj.material || "",
    r(obj.volume || 0, 6),
    r(obj.area || 0, 4),
    r(obj.weight || 0, 2),
    r(obj.length || 0, 3),
  ]);

  detailRows.push([]);
  detailRows.push([
    "", "TỔNG CỘNG", "", "", "", "", "", "", "", "",
    r(totalVolume, 6), r(totalArea, 4), r(totalWeight, 2), r(totalLength, 3),
  ]);

  const wsDetail = XLSX.utils.aoa_to_sheet([...detailHeader, ...detailRows]);
  wsDetail["!cols"] = [
    { wch: 6 }, { wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 22 },
    { wch: 18 }, { wch: 22 }, { wch: 18 },
    { wch: 18 }, { wch: 15 },
    { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 },
  ];
  wsDetail["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 13 } }];
  XLSX.utils.book_append_sheet(wb, wsDetail, "Chi tiết");

  // ── Sheet 3-7: Grouped sheets for each category ──
  const groupSheets = [
    { key: "assemblyPos", label: "Assembly Pos", sheetName: "Theo Assembly Pos" },
    { key: "assemblyName", label: "Assembly Name", sheetName: "Theo Assembly Name" },
    { key: "assemblyPosCode", label: "Assembly Code", sheetName: "Theo Assembly Code" },
    { key: "objectType", label: "Object Type", sheetName: "Theo Object Type" },
    { key: "name", label: "Tên", sheetName: "Theo Tên" },
    { key: "group", label: "Group", sheetName: "Theo Group" },
    { key: "material", label: "Vật liệu", sheetName: "Theo Vật liệu" },
    { key: "type", label: "IFC Type", sheetName: "Theo IFC Type" },
  ];

  for (const gs of groupSheets) {
    // Skip the sheet that matches the current summary grouping (already shown)
    if (gs.key === groupBy) continue;
    try {
      const ws = createGroupSheet(data, gs.key, gs.label);
      XLSX.utils.book_append_sheet(wb, ws, gs.sheetName);
    } catch (e) {
      console.warn(`[ExcelExport] Failed to create sheet "${gs.sheetName}":`, e);
    }
  }

  // ── Download ──
  const filename = `DDC_Statistics_${dateStr}${selectedOnly ? "_selected" : ""}.xlsx`;
  XLSX.writeFile(wb, filename);
  console.log(`[ExcelExport] Exported ${data.length} records to ${filename}`);
}

// ── Helper: Create a grouped summary sheet ──
function createGroupSheet(data, groupBy, label) {
  const groups = {};
  for (const obj of data) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { count: 0, volume: 0, weight: 0, area: 0, length: 0 };
    }
    groups[key].count++;
    groups[key].volume += obj.volume || 0;
    groups[key].weight += obj.weight || 0;
    groups[key].area += obj.area || 0;
    groups[key].length += obj.length || 0;
  }

  const rows = [
    [`THỐNG KÊ THEO ${label.toUpperCase()}`],
    [],
    [label, "Số lượng", "Thể tích (m³)", "Diện tích (m²)", "Khối lượng (kg)", "Chiều dài (m)"],
  ];

  let totalVol = 0, totalWt = 0, totalArea = 0, totalLen = 0;

  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    totalVol += g.volume;
    totalWt += g.weight;
    totalArea += g.area;
    totalLen += g.length;
    rows.push([key, g.count, r(g.volume, 6), r(g.area, 4), r(g.weight, 2), r(g.length, 3)]);
  }

  rows.push([]);
  rows.push(["TỔNG CỘNG", data.length, r(totalVol, 6), r(totalArea, 4), r(totalWt, 2), r(totalLen, 3)]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 35 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 15 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  return ws;
}

// ── Group key resolver ──
function getGroupKey(obj, groupBy) {
  switch (groupBy) {
    case "assemblyName": return obj.assemblyName || obj.assembly || "(Không xác định)";
    case "assemblyPos": return obj.assemblyPos || "(Không xác định)";
    case "assemblyPosCode": return obj.assemblyPosCode || "(Không xác định)";
    case "name": return obj.name;
    case "group": return obj.group;
    case "type": return obj.type;
    case "objectType": return obj.type || obj.ifcClass || "(Không xác định)";
    case "material": return obj.material;
    default: return obj.assemblyDisplayName || obj.assembly;
  }
}

// ── Group label for display ──
function getGroupLabel(groupBy) {
  switch (groupBy) {
    case "assemblyName": return "Assembly Name (Tekla)";
    case "assemblyPos": return "Assembly Pos (Tekla)";
    case "assemblyPosCode": return "Assembly Code (Tekla)";
    case "name": return "Tên";
    case "group": return "Group";
    case "type": return "IFC Type";
    case "objectType": return "Object Type";
    case "material": return "Vật liệu";
    default: return groupBy;
  }
}

function r(n, d) {
  return Number(Number(n || 0).toFixed(d));
}
