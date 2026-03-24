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
let allObjects = []; // { id, modelId, name, assembly, group, type, material, volume, weight, area, length, profile, class }
let filteredObjects = [];
let selectedIds = new Set(); // Set of "modelId:objectId"
let isolateActive = false;
let searchTimeout = null;
let lastClickedItem = null; // for Shift+click range selection
let lastClickAction = "select"; // "select" or "deselect" — for Shift range
let isSyncingFromViewer = false; // flag to prevent re-entry during sync
let lastViewerSelectionKey = ''; // dedup key for polling

// ── Init ──
export function initObjectExplorer(api, viewer) {
  apiRef = api;
  viewerRef = viewer;

  // Listen for model state changes
  onEvent("viewer.onModelStateChanged", () => {
    console.log("[ObjectExplorer] Model state changed, scanning...");
    scanObjects();
  });

  // Listen for TC viewer selection changes
  onEvent("viewer.onSelectionChanged", (data) => {
    // Skip echo events from our own setSelection calls
    if (isSyncingFromViewer) return;
    console.log("[ObjectExplorer] onSelectionChanged event:", JSON.stringify(data).substring(0, 500));
    handleViewerSelectionChanged(data);
  });

  // Backup: poll viewer.getSelection() every 2 seconds to catch missed events
  setInterval(async () => {
    if (isSyncingFromViewer || !viewerRef || allObjects.length === 0) return;
    try {
      const sel = await viewerRef.getSelection();
      if (sel) {
        handleViewerSelectionChanged(sel);
      }
    } catch (e) { /* ignore polling errors */ }
  }, 2000);

  // UI bindings
  document.getElementById("search-input").addEventListener("input", onSearchInput);
  document.getElementById("search-clear-btn").addEventListener("click", clearSearch);
  document.getElementById("group-by-select").addEventListener("change", renderTree);
  document.getElementById("btn-isolate").addEventListener("click", toggleIsolate);
  document.getElementById("btn-reset").addEventListener("click", resetAll);
  document.getElementById("btn-refresh").addEventListener("click", scanObjects);
}

// ── Export data for statistics module ──
export function getAllObjects() { return allObjects; }
export function getSelectedIds() { return selectedIds; }
export function getSelectedObjects() {
  if (selectedIds.size === 0) return [];
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
          type: "", material: "", volume: 0, weight: 0,
          area: 0, length: 0, profile: "", ifcClass: "",
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
    area: 0,
    length: 0,
    profile: "",
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

      // Surface Area (m²)
      if (propName === "area" || propName === "diện tích" || propName === "surfacearea"
          || propName === "surface area" || propName === "netsurfacearea" || propName === "grosssurfacearea"
          || propName === "totalsurfacearea" || propName === "netarea" || propName === "grossarea") {
        const a = parseFloat(propValue);
        if (!isNaN(a) && a > result.area) result.area = a;
      }

      // Length (m)
      if (propName === "length" || propName === "chiều dài" || propName === "span"
          || propName === "overalllength" || propName === "netlength" || propName === "totallength"
          || propName === "height" || propName === "chiều cao") {
        const l = parseFloat(propValue);
        if (!isNaN(l) && l > result.length) result.length = l;
      }

      // Profile
      if (propName === "profile" || propName === "profilename" || propName === "profile name"
          || propName === "profiletype" || propName === "cross section" || propName === "section"
          || propName === "sectionname" || propName === "crosssectionarea") {
        if (!result.profile) result.profile = String(propValue || "");
      }

      // Type from property
      if (!result.type && (propName === "objecttype" || propName === "type" || propName === "ifctype"
          || propName === "typename")) {
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
          o.ifcClass.toLowerCase().includes(q) ||
          (o.profile && o.profile.toLowerCase().includes(q))
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
      const displayLabel = getObjectDisplayName(obj);
      const tooltip = buildTooltip(obj);
      html += `<div class="tree-item${isSelected ? " selected" : ""}" data-uid="${escHtml(uid)}" data-model-id="${escHtml(obj.modelId)}" data-object-id="${obj.id}">`;
      html += `<input type="checkbox" class="tree-item-checkbox" ${isSelected ? "checked" : ""} />`;
      html += `<span class="tree-item-name" title="${escHtml(tooltip)}">${escHtml(displayLabel)}</span>`;
      if (obj.profile) {
        html += `<span class="tree-item-badge profile">${escHtml(obj.profile)}</span>`;
      } else if (obj.type) {
        html += `<span class="tree-item-badge">${escHtml(obj.type)}</span>`;
      }
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
  document.getElementById("groups-count").textContent = `${sortedKeys.length} nhóm`;

  // Bind click events with Shift+click support (select AND deselect range)
  const allItems = Array.from(container.querySelectorAll(".tree-item"));
  allItems.forEach((el, index) => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("tree-item-checkbox")) return;

      if (e.shiftKey && lastClickedItem !== null) {
        // Shift+click: apply same action (select or deselect) to range
        const lastIndex = allItems.indexOf(lastClickedItem);
        if (lastIndex >= 0) {
          const start = Math.min(lastIndex, index);
          const end = Math.max(lastIndex, index);
          const doSelect = (lastClickAction === "select");
          for (let i = start; i <= end; i++) {
            const item = allItems[i];
            const uid = item.dataset.uid;
            if (doSelect) {
              selectedIds.add(uid);
              item.classList.add("selected");
              item.querySelector(".tree-item-checkbox").checked = true;
            } else {
              selectedIds.delete(uid);
              item.classList.remove("selected");
              item.querySelector(".tree-item-checkbox").checked = false;
            }
          }
          updateSummary();
          notifySelectionChanged();
          applyHighlightColors();
          syncSelectionToViewer();
          return;
        }
      }

      const uid = el.dataset.uid;
      // Track whether this click is select or deselect
      lastClickAction = selectedIds.has(uid) ? "deselect" : "select";
      toggleSelection(uid, el);
      lastClickedItem = el;
    });

    el.querySelector(".tree-item-checkbox").addEventListener("change", (e) => {
      const uid = el.dataset.uid;
      if (e.target.checked) {
        selectedIds.add(uid);
        el.classList.add("selected");
        lastClickAction = "select";
      } else {
        selectedIds.delete(uid);
        el.classList.remove("selected");
        lastClickAction = "deselect";
      }
      lastClickedItem = el;
      updateSummary();
      notifySelectionChanged();
      applyHighlightColors();
      syncSelectionToViewer();
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
  applyHighlightColors();
  syncSelectionToViewer();
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


// Apply colored highlight overlay to all selected objects (auto-highlight)
async function applyHighlightColors() {
  try {
    // Always reset colors first
    await viewerRef.setObjectState(undefined, { color: "reset" });
  } catch (e) { /* ignore */ }

  if (selectedIds.size === 0) return;

  const modelMap = buildModelMap();

  try {
    // Apply color overlay (bright blue highlight) to selected objects
    await viewerRef.setObjectState(
      {
        modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
          modelId,
          objectRuntimeIds: ids,
        })),
      },
      { color: { r: 255, g: 220, b: 0, a: 220 } }
    );

    console.log(`[ObjectExplorer] Auto-highlighted ${selectedIds.size} objects`);
  } catch (e) {
    console.error("[ObjectExplorer] Highlight color failed:", e);
  }
}

// Sync panel selection to TC viewer (one-way: panel → viewer)
async function syncSelectionToViewer() {
  const modelMap = buildModelMap();
  try {
    isSyncingFromViewer = true;

    if (selectedIds.size === 0) {
      await viewerRef.setSelection({ modelObjectIds: [] }, "set");
    } else {
      await viewerRef.setSelection(
        {
          modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
            modelId,
            objectRuntimeIds: ids,
          })),
        },
        "set"
      );
    }
  } catch (e) {
    console.warn("[ObjectExplorer] setSelection failed:", e);
  } finally {
    // Keep flag on for 200ms to absorb the echo event
    setTimeout(() => { isSyncingFromViewer = false; }, 200);
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

// ── Build a descriptive display name for tree items ──
function getObjectDisplayName(obj) {
  let name = obj.name || "";
  if (!name || /^Object \d+$/.test(name)) {
    if (obj.assembly) name = obj.assembly;
    else if (obj.type) name = obj.type;
    else if (obj.ifcClass) name = obj.ifcClass;
    else name = `Object ${obj.id}`;
  }
  return name;
}

// ── Build a rich tooltip with all available info ──
function buildTooltip(obj) {
  const parts = [];
  if (obj.name) parts.push(`Tên: ${obj.name}`);
  if (obj.profile) parts.push(`Profile: ${obj.profile}`);
  if (obj.type) parts.push(`Type: ${obj.type}`);
  if (obj.ifcClass) parts.push(`IFC Class: ${obj.ifcClass}`);
  if (obj.assembly) parts.push(`Assembly: ${obj.assembly}`);
  if (obj.material) parts.push(`Vật liệu: ${obj.material}`);
  return parts.join(' | ') || `Object ${obj.id}`;
}

// ── Build a label combining name + profile + type for 3D labels ──
function getObjectLabel(obj) {
  const parts = [];
  // Name (skip generic)
  const name = obj.name || "";
  if (name && !/^Object \d+$/.test(name)) parts.push(name);
  // Profile
  if (obj.profile) parts.push(obj.profile);
  // Type (if different from name)
  if (obj.type && obj.type !== name) parts.push(obj.type);
  // IFC Class as last resort
  if (parts.length === 0 && obj.ifcClass) parts.push(obj.ifcClass);
  if (parts.length === 0) parts.push(`Object ${obj.id}`);
  return parts.join(' — ');
}

// ── Handle TC Viewer selection → sync tree checkboxes + statistics ──
// Called when user single-clicks or area-selects objects in TC 3D viewer.
// Simple approach: parse IDs, match against allObjects, update panel UI + stats.
function handleViewerSelectionChanged(data) {
  if (!allObjects || allObjects.length === 0) return;

  try {
    // Step 1: Extract all object IDs from event data
    const incomingUids = new Set();

    // Handle multiple data formats from TC API
    let entries = null;
    if (data && data.modelObjectIds) {
      entries = data.modelObjectIds;
    } else if (Array.isArray(data)) {
      entries = data;
    } else if (data && typeof data === 'object' && data.modelId) {
      entries = [data];
    }

    if (entries && Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || !entry.modelId) continue;
        const modelId = entry.modelId;
        // Try all possible ID field names
        const ids = entry.objectRuntimeIds || entry.entityIds || entry.ids || [];
        for (const id of ids) {
          incomingUids.add(`${modelId}:${id}`);
        }
      }
    }

    // Step 2: Dedup — if same selection as last time (from polling), skip
    const selKey = Array.from(incomingUids).sort().join(',');
    if (selKey === lastViewerSelectionKey) return;
    lastViewerSelectionKey = selKey;

    // Step 3: Empty selection → keep panel state (persistent memory)
    if (incomingUids.size === 0) {
      console.log("[ObjectExplorer] Viewer empty selection — keeping panel state");
      return;
    }

    // Step 4: Match incoming IDs against our allObjects
    const knownUids = new Set(allObjects.map(o => `${o.modelId}:${o.id}`));
    const matchedUids = new Set();
    const unmatchedCount = { count: 0 };

    for (const uid of incomingUids) {
      if (knownUids.has(uid)) {
        matchedUids.add(uid);
      } else {
        unmatchedCount.count++;
      }
    }

    console.log(`[ObjectExplorer] Viewer selection: ${incomingUids.size} IDs, ${matchedUids.size} matched, ${unmatchedCount.count} unmatched`);

    // If zero matches, keep current panel state
    if (matchedUids.size === 0) {
      console.log("[ObjectExplorer] No matching objects in panel for viewer selection");
      return;
    }

    // Step 5: Apply selection to panel
    selectedIds.clear();
    for (const uid of matchedUids) {
      selectedIds.add(uid);
    }

    // Step 6: Update tree UI checkboxes + auto-expand collapsed groups
    const treeItems = document.querySelectorAll(".tree-item");
    for (const el of treeItems) {
      const uid = el.dataset.uid;
      const isSelected = selectedIds.has(uid);
      el.classList.toggle("selected", isSelected);
      const cb = el.querySelector(".tree-item-checkbox");
      if (cb) cb.checked = isSelected;

      // Auto-expand collapsed parent group
      if (isSelected) {
        const group = el.closest(".tree-group");
        if (group && group.classList.contains("collapsed")) {
          group.classList.remove("collapsed");
        }
      }
    }

    // Step 7: Scroll first selected item into view
    const firstSel = document.querySelector(".tree-item.selected");
    if (firstSel) {
      firstSel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // Step 8: Update summary + statistics
    updateSummary();
    notifySelectionChanged();
    applyHighlightColors();

  } catch (e) {
    console.warn("[ObjectExplorer] Viewer selection sync error:", e);
  }
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
  lastClickedItem = null;

  const btnIsolate = document.getElementById("btn-isolate");
  if (btnIsolate) btnIsolate.classList.remove("active");

  try {
    // Clear selection
    await viewerRef.setSelection({ modelObjectIds: [] }, "set");
  } catch (e) { /* ignore */ }

  try {
    // Reset object states (visibility, color)
    await viewerRef.setObjectState(undefined, { visible: "reset", color: "reset" });
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
