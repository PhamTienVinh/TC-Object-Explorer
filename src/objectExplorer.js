/**
 * objectExplorer.js — IFC Object Statistics, Search, Highlight, Isolate & Labels
 *
 * Scans all objects from loaded models, extracts IFC properties,
 * groups them, provides real-time search, 3D highlight/isolate, and labels.
 */

import { onEvent } from "./main.js";

// ── State ──
let apiRef = null;
let viewerRef = null;
let allObjects = []; // { id, modelId, name, assembly, group, type, material, volume, weight, class }
let filteredObjects = [];
let selectedIds = new Set(); // Set of "modelId:objectId"
let labelsVisible = false;
let isolateActive = false;
let highlightActive = false;
let searchTimeout = null;
let currentLabelIcons = []; // track added icon IDs for removal
let lastClickedItem = null; // for Shift+click range selection

// ── Init ──
export function initObjectExplorer(api, viewer) {
  apiRef = api;
  viewerRef = viewer;

  // Listen for model state changes
  onEvent("viewer.onModelStateChanged", () => {
    console.log("[ObjectExplorer] Model state changed, scanning...");
    scanObjects();
  });

  // UI bindings
  document.getElementById("search-input").addEventListener("input", onSearchInput);
  document.getElementById("search-clear-btn").addEventListener("click", clearSearch);
  document.getElementById("group-by-select").addEventListener("change", renderTree);
  document.getElementById("btn-highlight").addEventListener("click", highlightSelected);
  document.getElementById("btn-isolate").addEventListener("click", toggleIsolate);
  document.getElementById("btn-show-labels").addEventListener("click", toggleLabels);
  document.getElementById("btn-reset").addEventListener("click", resetAll);
  document.getElementById("btn-refresh").addEventListener("click", scanObjects);
}

// ── Export data for statistics module ──
export function getAllObjects() { return allObjects; }
export function getSelectedIds() { return selectedIds; }
export function getSelectedObjects() {
  if (selectedIds.size === 0) return allObjects;
  return allObjects.filter((o) => selectedIds.has(`${o.modelId}:${o.id}`));
}

// ── Object Scanning ──
async function scanObjects() {
  showLoading(true);
  allObjects = [];

  try {
    // Get all loaded models
    let models = [];
    try {
      models = await viewerRef.getModels("loaded");
      console.log("[ObjectExplorer] Loaded models:", models);
    } catch (e) {
      console.warn("[ObjectExplorer] getModels failed:", e);
      try {
        models = await viewerRef.getModels();
        console.log("[ObjectExplorer] All models:", models);
      } catch (e2) {
        console.warn("[ObjectExplorer] getModels() also failed:", e2);
      }
    }

    // Strategy 1: getObjects() returns ModelObjects[] with full ObjectProperties
    let modelObjectsList = [];
    try {
      modelObjectsList = await viewerRef.getObjects();
      console.log("[ObjectExplorer] getObjects() returned:", modelObjectsList?.length, "models");
    } catch (e) {
      console.warn("[ObjectExplorer] getObjects() failed:", e);
    }

    if (modelObjectsList && modelObjectsList.length > 0) {
      // ModelObjects has { modelId, objects: ObjectProperties[] }
      for (const modelObjs of modelObjectsList) {
        const modelId = modelObjs.modelId;
        const objects = modelObjs.objects || [];

        if (objects.length === 0) continue;

        // Check if objects already have full properties (class, product, properties)
        const hasProperties = objects[0] && objects[0].properties;

        if (hasProperties) {
          // Objects already have inline properties — parse directly
          for (const obj of objects) {
            const parsed = parseObjectProperties(obj, modelId);
            allObjects.push(parsed);
          }
        } else {
          // Objects are minimal (just IDs) — need to fetch properties
          const objectIds = objects.map((o) => (typeof o === "number" ? o : o.id));
          await fetchAndParseProperties(modelId, objectIds);
        }
      }
    }

    // Strategy 2: If no objects, try per-model fetching
    if (allObjects.length === 0 && models.length > 0) {
      for (const model of models) {
        if (model.state && model.state !== "loaded") continue;
        try {
          const modelObjs = await viewerRef.getObjects({
            modelObjectIds: [{ modelId: model.id }],
          });
          if (modelObjs) {
            for (const mo of modelObjs) {
              const objects = mo.objects || [];
              for (const obj of objects) {
                allObjects.push(parseObjectProperties(obj, mo.modelId));
              }
            }
          }
        } catch (e) {
          console.warn(`[ObjectExplorer] Per-model fetch failed for ${model.id}:`, e);
        }
      }
    }

    // Strategy 3: Hierarchy-based approach
    if (allObjects.length === 0 && models.length > 0) {
      for (const model of models) {
        if (model.state && model.state !== "loaded") continue;
        try {
          // Get root entities via spatial hierarchy
          const rootEntities = await viewerRef.getHierarchyChildren(model.id, [0], 1, true);
          if (rootEntities && rootEntities.length > 0) {
            const entityIds = rootEntities.map((e) => e.id);
            await fetchAndParseProperties(model.id, entityIds);
          }
        } catch (e) {
          console.warn(`[ObjectExplorer] Hierarchy fetch failed for ${model.id}:`, e);
        }
      }
    }

    console.log(`[ObjectExplorer] Scanned ${allObjects.length} objects`);

    filteredObjects = [...allObjects];
    selectedIds.clear();
    updateSummary();
    renderTree();
    hidePlaceholder();

    // Notify statistics module
    window.dispatchEvent(new CustomEvent("objects-scanned", { detail: allObjects }));

  } catch (error) {
    console.error("[ObjectExplorer] Scan failed:", error);
  } finally {
    showLoading(false);
  }
}

// ── Fetch properties in batches ──
async function fetchAndParseProperties(modelId, objectIds) {
  const BATCH_SIZE = 50;
  for (let i = 0; i < objectIds.length; i += BATCH_SIZE) {
    const batch = objectIds.slice(i, i + BATCH_SIZE);
    try {
      const propsArray = await viewerRef.getObjectProperties(modelId, batch);
      if (propsArray) {
        for (const props of propsArray) {
          allObjects.push(parseObjectProperties(props, modelId));
        }
      }
    } catch (e) {
      console.warn(`[ObjectExplorer] getObjectProperties batch failed:`, e);
      // Add with minimal info
      for (const objId of batch) {
        allObjects.push({
          id: objId, modelId,
          name: `Object ${objId}`, assembly: "", group: "",
          type: "", material: "", volume: 0, weight: 0, ifcClass: "",
        });
      }
    }
  }
}

// ── Parse ObjectProperties ──
// ObjectProperties: { id: number, class?: string, product?: Product, properties?: PropertySet[] }
// Product: { name?: string, description?: string, objectType?: string }
// PropertySet: { name?: string, properties?: Property[] }
// Property: { name: string, value: string|number, type: PropertyType }
function parseObjectProperties(props, modelId) {
  const result = {
    id: props.id,
    modelId,
    name: "",
    assembly: "",
    group: "",
    type: "",
    material: "",
    volume: 0,
    weight: 0,
    ifcClass: props.class || "",
  };

  // Product info (standardized)
  if (props.product) {
    result.name = props.product.name || "";
    result.type = props.product.objectType || props.class || "";
  }

  // IFC Class as type fallback
  if (!result.type && props.class) {
    result.type = props.class;
  }

  // Parse property sets
  const propertySets = props.properties || [];
  for (const pSet of propertySets) {
    const setName = (pSet.name || "").toLowerCase();
    const properties = pSet.properties || [];

    for (const prop of properties) {
      const propName = (prop.name || "").toLowerCase();
      const propValue = prop.value;
      const propType = prop.type;

      // Name (if not already set from product)
      if (!result.name && (propName === "name" || propName === "tên")) {
        result.name = String(propValue || "");
      }

      // Assembly
      if (propName === "assembly" || propName === "assemblycode" || propName === "assembly code"
          || propName === "assembly mark" || propName === "assemblymark"
          || propName === "assembly_mark") {
        if (!result.assembly) result.assembly = String(propValue || "");
      }

      // Group
      if (propName === "group" || propName === "nhóm" || propName === "groupname"
          || propName === "group name") {
        if (!result.group) result.group = String(propValue || "");
      }

      // Material
      if (propName === "material" || propName === "vật liệu" || propName === "materials"
          || propName === "materialname") {
        if (!result.material) result.material = String(propValue || "");
      }

      // Volume (PropertyType.VolumeMeasure = 2, value in m³)
      if (propType === 2 || propName === "volume" || propName === "thể tích"
          || propName === "grossvolume" || propName === "netvolume" || propName === "net volume") {
        const v = parseFloat(propValue);
        if (!isNaN(v) && v > result.volume) result.volume = v;
      }

      // Weight (PropertyType.MassMeasure = 3, value in kg)
      if (propType === 3 || propName === "weight" || propName === "khối lượng"
          || propName === "grossweight" || propName === "netweight" || propName === "mass") {
        const w = parseFloat(propValue);
        if (!isNaN(w) && w > 0 && w > result.weight) result.weight = w;
      }

      // Type from property
      if (!result.type && (propName === "objecttype" || propName === "type" || propName === "ifctype")) {
        result.type = String(propValue || "");
      }
    }
  }

  // Fallback name
  if (!result.name) result.name = `Object ${props.id}`;

  // Calculate weight from volume if not provided (steel density = 7850 kg/m³)
  if (result.weight === 0 && result.volume > 0) {
    result.weight = result.volume * 7850;
  }

  return result;
}

// ── Search ──
function onSearchInput(e) {
  const query = e.target.value.trim();
  document.getElementById("search-clear-btn").style.display = query ? "block" : "none";

  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (!query) {
      filteredObjects = [...allObjects];
    } else {
      const q = query.toLowerCase();
      filteredObjects = allObjects.filter(
        (o) =>
          o.name.toLowerCase().includes(q) ||
          o.assembly.toLowerCase().includes(q) ||
          o.group.toLowerCase().includes(q) ||
          o.type.toLowerCase().includes(q) ||
          o.material.toLowerCase().includes(q) ||
          o.ifcClass.toLowerCase().includes(q)
      );
    }
    updateSummary();
    renderTree();
  }, 250);
}

function clearSearch() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear-btn").style.display = "none";
  filteredObjects = [...allObjects];
  updateSummary();
  renderTree();
}

// ── Tree Rendering ──
function renderTree() {
  const container = document.getElementById("object-tree");
  const groupBy = document.getElementById("group-by-select").value;

  if (filteredObjects.length === 0) {
    container.innerHTML = "";
    showPlaceholder();
    return;
  }

  // Group objects
  const groups = {};
  for (const obj of filteredObjects) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) groups[key] = [];
    groups[key].push(obj);
  }

  const sortedKeys = Object.keys(groups).sort();

  let html = "";
  for (const key of sortedKeys) {
    const items = groups[key];
    html += `<div class="tree-group" data-group="${escHtml(key)}">`;
    html += `<div class="tree-group-header" onclick="this.parentElement.classList.toggle('collapsed')">`;
    html += `<span class="tree-toggle">▼</span>`;
    html += `<span class="tree-group-name">${escHtml(key)}</span>`;
    html += `<span class="tree-group-count">${items.length}</span>`;
    html += `</div>`;
    html += `<div class="tree-items">`;

    for (const obj of items) {
      const uid = `${obj.modelId}:${obj.id}`;
      const isSelected = selectedIds.has(uid);
      html += `<div class="tree-item${isSelected ? " selected" : ""}" data-uid="${escHtml(uid)}" data-model-id="${escHtml(obj.modelId)}" data-object-id="${obj.id}">`;
      html += `<input type="checkbox" class="tree-item-checkbox" ${isSelected ? "checked" : ""} />`;
      html += `<span class="tree-item-name" title="${escHtml(obj.name)}">${escHtml(obj.name)}</span>`;
      if (obj.type) {
        html += `<span class="tree-item-badge">${escHtml(obj.type)}</span>`;
      }
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
  document.getElementById("groups-count").textContent = `${sortedKeys.length} nhóm`;

  // Bind click events with Shift+click support
  const allItems = Array.from(container.querySelectorAll(".tree-item"));
  allItems.forEach((el, index) => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("tree-item-checkbox")) return;

      if (e.shiftKey && lastClickedItem !== null) {
        // Shift+click: select range
        const lastIndex = allItems.indexOf(lastClickedItem);
        if (lastIndex >= 0) {
          const start = Math.min(lastIndex, index);
          const end = Math.max(lastIndex, index);
          for (let i = start; i <= end; i++) {
            const item = allItems[i];
            const uid = item.dataset.uid;
            selectedIds.add(uid);
            item.classList.add("selected");
            item.querySelector(".tree-item-checkbox").checked = true;
          }
          updateSummary();
          notifySelectionChanged();
          if (highlightActive) autoHighlightSelected();
          return;
        }
      }

      const uid = el.dataset.uid;
      toggleSelection(uid, el);
      lastClickedItem = el;
    });

    el.querySelector(".tree-item-checkbox").addEventListener("change", (e) => {
      const uid = el.dataset.uid;
      if (e.target.checked) {
        selectedIds.add(uid);
        el.classList.add("selected");
      } else {
        selectedIds.delete(uid);
        el.classList.remove("selected");
      }
      lastClickedItem = el;
      updateSummary();
      notifySelectionChanged();
      if (highlightActive) autoHighlightSelected();
    });
  });
}

function toggleSelection(uid, el) {
  if (selectedIds.has(uid)) {
    selectedIds.delete(uid);
    el.classList.remove("selected");
    el.querySelector(".tree-item-checkbox").checked = false;
  } else {
    selectedIds.add(uid);
    el.classList.add("selected");
    el.querySelector(".tree-item-checkbox").checked = true;
  }
  updateSummary();
  notifySelectionChanged();

  // Quick highlight on single click (selection outline in 3D)
  const [modelId, objectId] = uid.split(":");
  highlightSingle(modelId, parseInt(objectId));

  // If highlight mode is active, also apply colored highlight to all selected
  if (highlightActive) autoHighlightSelected();
}

function getGroupKey(obj, groupBy) {
  switch (groupBy) {
    case "assembly": return obj.assembly;
    case "name": return obj.name;
    case "group": return obj.group;
    case "type": return obj.type;
    case "material": return obj.material;
    default: return obj.assembly;
  }
}

// ── Highlight ──
async function highlightSingle(modelId, objectId) {
  try {
    await viewerRef.setSelection(
      { modelObjectIds: [{ modelId, objectRuntimeIds: [objectId] }] },
      "set"
    );
  } catch (e) {
    console.warn("[ObjectExplorer] setSelection failed:", e);
  }
}

async function highlightSelected() {
  // Toggle highlight mode ON
  highlightActive = true;
  document.getElementById("btn-highlight").classList.add("active");

  if (selectedIds.size === 0) {
    console.log("[ObjectExplorer] Highlight mode ON — no objects selected yet");
    return;
  }

  await autoHighlightSelected();
}

// Auto-apply colored highlight to all currently selected objects
async function autoHighlightSelected() {
  if (selectedIds.size === 0) return;

  const modelMap = buildModelMap();

  try {
    // Set selection
    await viewerRef.setSelection(
      {
        modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
          modelId,
          objectRuntimeIds: ids,
        })),
      },
      "set"
    );

    // Apply color overlay (bright blue highlight)
    await viewerRef.setObjectState(
      {
        modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
          modelId,
          objectRuntimeIds: ids,
        })),
      },
      { color: { r: 88, g: 166, b: 255, a: 200 } }
    );

    console.log(`[ObjectExplorer] Auto-highlighted ${selectedIds.size} objects`);
  } catch (e) {
    console.error("[ObjectExplorer] Highlight failed:", e);
  }
}

// ── Isolate ──
async function toggleIsolate() {
  const btn = document.getElementById("btn-isolate");

  if (isolateActive) {
    // Reset: show all objects again
    try {
      // Reset visibility for all objects
      await viewerRef.setObjectState(undefined, { visible: "reset" });
      await viewerRef.setObjectState(undefined, { color: "reset" });
      isolateActive = false;
      btn.classList.remove("active");
      console.log("[ObjectExplorer] Isolation reset");
    } catch (e) {
      console.warn("[ObjectExplorer] Reset state failed:", e);
      try {
        await viewerRef.reset();
        isolateActive = false;
        btn.classList.remove("active");
      } catch (e2) {
        console.error("[ObjectExplorer] Full reset also failed:", e2);
      }
    }
    return;
  }

  if (selectedIds.size === 0) return;

  const modelMap = buildModelMap();

  try {
    // isolateEntities uses IModelEntities[] with { modelId, entityIds }
    await viewerRef.isolateEntities(
      Object.entries(modelMap).map(([modelId, ids]) => ({
        modelId,
        entityIds: ids,
      }))
    );
    isolateActive = true;
    btn.classList.add("active");
    console.log(`[ObjectExplorer] Isolated ${selectedIds.size} objects`);
  } catch (e) {
    console.error("[ObjectExplorer] Isolate failed:", e);
    // Fallback: hide all, show selected
    try {
      await viewerRef.setObjectState(undefined, { visible: false });
      await viewerRef.setObjectState(
        {
          modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
            modelId,
            objectRuntimeIds: ids,
          })),
        },
        { visible: true }
      );
      isolateActive = true;
      btn.classList.add("active");
    } catch (e2) {
      console.error("[ObjectExplorer] Fallback isolate failed:", e2);
    }
  }
}

// ── Labels (using addIcon API with text, or bounding box overlay) ──
async function toggleLabels() {
  const btn = document.getElementById("btn-show-labels");

  if (labelsVisible) {
    // Remove labels
    try {
      if (currentLabelIcons.length > 0) {
        await viewerRef.removeIcon(currentLabelIcons);
      } else {
        await viewerRef.removeIcon();
      }
    } catch (e) {
      console.warn("[ObjectExplorer] removeIcon failed:", e);
    }
    currentLabelIcons = [];
    labelsVisible = false;
    btn.classList.remove("active");
    console.log("[ObjectExplorer] Labels removed");
    return;
  }

  const objectsToLabel = selectedIds.size > 0
    ? allObjects.filter((o) => selectedIds.has(`${o.modelId}:${o.id}`))
    : filteredObjects.slice(0, 100); // Limit labels

  if (objectsToLabel.length === 0) return;

  try {
    // Get bounding boxes to position labels
    const labelsByModel = {};
    for (const obj of objectsToLabel) {
      if (!labelsByModel[obj.modelId]) labelsByModel[obj.modelId] = [];
      labelsByModel[obj.modelId].push(obj);
    }

    const icons = [];
    let iconIdCounter = 1000;

    for (const [modelId, objs] of Object.entries(labelsByModel)) {
      const runtimeIds = objs.map((o) => o.id);

      try {
        // Get bounding boxes for positioning
        const bboxes = await viewerRef.getObjectBoundingBoxes(modelId, runtimeIds);

        if (bboxes && bboxes.length > 0) {
          for (let i = 0; i < bboxes.length; i++) {
            const bbox = bboxes[i];
            const obj = objs.find((o) => o.id === bbox.id) || objs[i];
            if (!bbox.boundingBox) continue;

            // Position label at top-center of bounding box
            const bb = bbox.boundingBox;
            const pos = {
              x: (bb.min.x + bb.max.x) / 2,
              y: (bb.min.y + bb.max.y) / 2,
              z: bb.max.z + 0.3, // slightly above the object
            };

            icons.push({
              id: iconIdCounter++,
              iconPath: createLabelSvgDataUrl(getObjectLabel(obj)),
              position: pos,
              size: 48,
            });
          }
        }
      } catch (e) {
        console.warn(`[ObjectExplorer] getBoundingBoxes failed for model ${modelId}:`, e);

        // Fallback: try getObjectPositions
        try {
          const positions = await viewerRef.getObjectPositions(modelId, runtimeIds);
          if (positions) {
            for (const posData of positions) {
              const obj = objs.find((o) => o.id === posData.id);
              if (!obj || !posData.position) continue;

              icons.push({
                id: iconIdCounter++,
                iconPath: createLabelSvgDataUrl(getObjectLabel(obj)),
                position: {
                  x: posData.position.x,
                  y: posData.position.y,
                  z: posData.position.z + 0.5,
                },
                size: 48,
              });
            }
          }
        } catch (e2) {
          console.warn("[ObjectExplorer] getObjectPositions also failed:", e2);
        }
      }
    }

    if (icons.length > 0) {
      await viewerRef.addIcon(icons);
      currentLabelIcons = icons;
      labelsVisible = true;
      btn.classList.add("active");
      console.log(`[ObjectExplorer] Added ${icons.length} label icons`);
    } else {
      // Final fallback: just highlight + select to show tooltip
      await highlightSelected();
      labelsVisible = true;
      btn.classList.add("active");
      console.log("[ObjectExplorer] Labels shown via selection tooltip");
    }
  } catch (error) {
    console.error("[ObjectExplorer] Labels failed:", error);
  }
}

// ── Build a descriptive label for an object ──
function getObjectLabel(obj) {
  // Priority: name > assembly > type/ifcClass > fallback
  let label = obj.name || "";
  // If name is generic ("Object 123"), try better alternatives
  if (!label || /^Object \d+$/.test(label)) {
    if (obj.assembly) label = obj.assembly;
    else if (obj.type) label = obj.type;
    else if (obj.ifcClass) label = obj.ifcClass;
    else label = `Object ${obj.id}`;
  }
  return label;
}

// ── Create SVG label as data URL ──
function createLabelSvgDataUrl(text) {
  const shortText = text.length > 30 ? text.substring(0, 27) + "..." : text;
  const width = Math.max(120, shortText.length * 8 + 20);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32">
    <defs>
      <filter id="s" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.5"/>
      </filter>
    </defs>
    <rect x="0" y="0" width="${width}" height="28" rx="6" ry="6"
          fill="rgba(13,17,23,0.9)" stroke="#58a6ff" stroke-width="1.5" filter="url(#s)"/>
    <text x="${width/2}" y="18" text-anchor="middle"
          font-family="Inter,Arial,sans-serif" font-size="11" font-weight="600"
          fill="#e6edf3">${escXml(shortText)}</text>
    <polygon points="${width/2-5},28 ${width/2},34 ${width/2+5},28" fill="rgba(13,17,23,0.9)" stroke="#58a6ff" stroke-width="1"/>
  </svg>`;

  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}

// ── Reset ──
async function resetAll() {
  selectedIds.clear();
  isolateActive = false;
  labelsVisible = false;
  highlightActive = false;
  currentLabelIcons = [];
  lastClickedItem = null;

  document.getElementById("btn-isolate").classList.remove("active");
  document.getElementById("btn-show-labels").classList.remove("active");
  document.getElementById("btn-highlight").classList.remove("active");

  try {
    // Clear selection
    await viewerRef.setSelection({ modelObjectIds: [] }, "set");
  } catch (e) { /* ignore */ }

  try {
    // Reset object states (visibility, color)
    await viewerRef.setObjectState(undefined, { visible: "reset", color: "reset" });
  } catch (e) { /* ignore */ }

  try {
    // Remove label icons
    await viewerRef.removeIcon();
  } catch (e) { /* ignore */ }

  updateSummary();
  notifySelectionChanged();
  renderTree();
  console.log("[ObjectExplorer] Reset complete");
}

// ── Helpers ──
function buildModelMap() {
  const map = {};
  for (const uid of selectedIds) {
    const idx = uid.indexOf(":");
    const modelId = uid.substring(0, idx);
    const objectId = parseInt(uid.substring(idx + 1));
    if (!map[modelId]) map[modelId] = [];
    if (!isNaN(objectId)) map[modelId].push(objectId);
  }
  return map;
}

function updateSummary() {
  document.getElementById("total-objects-count").textContent = `${filteredObjects.length} objects`;
  document.getElementById("selected-objects-count").textContent = `${selectedIds.size} đã chọn`;
}

function showLoading(show) {
  document.getElementById("loading-overlay").style.display = show ? "flex" : "none";
}

function showPlaceholder() {
  document.getElementById("tree-placeholder").style.display = "flex";
}

function hidePlaceholder() {
  document.getElementById("tree-placeholder").style.display =
    filteredObjects.length > 0 ? "none" : "flex";
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function escXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Notify statistics module of selection change ──
function notifySelectionChanged() {
  window.dispatchEvent(new CustomEvent("selection-changed", {
    detail: { selectedIds: Array.from(selectedIds), count: selectedIds.size }
  }));
}
