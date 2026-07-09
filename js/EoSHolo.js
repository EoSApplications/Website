/**
 * EoSHolo — interactive calibration-network graph.
 *
 * Data comes from Website_Files/Assets/data/Calibration_Graph.json, a static
 * snapshot built once at publish time by Website_Files/Build/Build_Calibration_Graph.py
 * (regular desktop Python, not Pyodide — the website only ever serves a
 * read-only, curated cache; there's no in-browser editing or per-visitor
 * calibration storage). Everything after the fetch — layout, traversal
 * (ancestors/descendants/chains), drawing, pan/zoom/drag, and focus-mode
 * switching — runs in plain JS against that JSON, mirroring EoSHolo.py's
 * Update_Graph / Get_Study_Chain / Get_Node_Descendants /
 * Get_Node_Chains_Through_Set methods.
 *
 * Known simplifications vs. the desktop app (tracked as follow-ups, not bugs):
 *  - Column/row grid layout instead of the Qt version's dynamic font-based
 *    column sizing — visually similar (composition columns, depth-ordered
 *    rows) but not pixel-identical.
 *  - No reciprocal-edge special-casing in node-class resolution.
 *  - "Preview Calibrant" is read-only (no in-browser YAML editing), and only
 *    ever shows the canonical, curated YAML — never a user's local edits.
 */

(() => {
    const NODE_STYLES = {
        normal:        { shape: "ellipse",  fillKey: "Tertiary_Text",   radiusScale: 1.0 },
        selected:      { shape: "star",     fillKey: "Primary_Color",   radiusScale: 2.5 },
        chain:         { shape: "ellipse",  fillKey: "Secondary_Color", radiusScale: 1.0 },
        through_child: { shape: "ellipse",  fillKey: "Tertiary_Color",  radiusScale: 1.0 },
        missing:       { shape: "triangle", fillKey: "Warning_Color",   radiusScale: 1.0 },
        absolute:      { shape: "diamond",  fillKey: "Quaternary_Text", radiusScale: 1.0 },
        not_specified: { shape: "square",   fillKey: "Quaternary_Text", radiusScale: 1.0 },
    };
    // Sizing/spacing constants mirror EoSHolo.py's Update_Graph exactly — see
    // that method for the authoritative comments. These are layout rules
    // ported from the desktop app, not arbitrary visual tuning.
    const PAD_H_FRAC = 0.03;                  // vertical edge padding
    const PAD_W_FRAC = 0.01;                  // horizontal edge padding
    const H_GAP_FRAC = 0.01;                  // gap between composition columns
    const V_GAP_FRAC = 0.005;                 // gap between same-zone nodes
    const MAX_COLUMN_LABEL_FONT_SIZE = 20;
    const MAX_NODE_LABEL_FONT_SIZE = 10;
    const MAX_NODE_DIAMETER = 25;
    const GLOBAL_ROW_NODE_COUNT_THRESHOLD = 50;
    // Canvas has no QFontMetrics equivalent; this approximates a font's pixel
    // line-height from its point size — close enough for layout purposes,
    // not a literal port of Qt's font metrics.
    const FONT_HEIGHT_MULTIPLIER = 1.3;
    const EDGE_SOURCE_GAP = 8;
    const EDGE_TARGET_GAP = 14;
    const EDGE_STYLE_NORMAL = { colorKey: "Tertiary_Text", width: 2 };
    const EDGE_STYLE_CHAIN  = { colorKey: "Secondary_Text", width: 4 };

    const State = {
        graph: null,                 // { nodes: [...], compositions: [...], composition_display_names: {...} }
        lookup: new Map(),           // node_id -> node
        childrenOf: new Map(),       // node_id -> [child node_id, ...]
        depths: new Map(),           // node_id -> depth (ancestors-only; special nodes = -1)
        manualPositions: new Map(),  // node_id -> {x, y}, set by dragging a node
        theme: { light: {}, dark: {} },

        focusMode: "default",        // default | to_node | through_node
        focusNodeId: null,

        view: { x: 0, y: 0, scale: 1 },   // pan/zoom transform (world -> screen: screen = world*scale + {x,y})
        lastLayout: null,                 // node_id -> {x, y, radius, nodeClass, labelText} in world space, from the most recent draw
        lastNodeBaseRadius: 0,            // world-space radius before per-class radiusScale, from the most recent draw
    };

    const El = {};

    document.addEventListener("DOMContentLoaded", () => {
        El.app = document.getElementById("eosholo-app");
        El.loading = document.getElementById("eosholo-loading");
        El.loadingMessage = document.getElementById("eosholo-loading-message");
        El.controls = document.getElementById("eosholo-controls");
        El.compositionDropdown = Make_Dropdown_Widget(
            document.getElementById("composition-dropdown"), "Select a composition..."
        );
        El.studyDropdown = Make_Dropdown_Widget(
            document.getElementById("study-dropdown"), "Select a pressure calibration study..."
        );
        El.previewButton = document.getElementById("preview-calibrant-button");
        El.resetZoomButton = document.getElementById("reset-zoom-button");
        El.showAllCheckbox = document.getElementById("show-all-checkbox");
        El.graphContainer = document.getElementById("eosholo-graph-container");
        El.canvas = document.getElementById("eosholo-graph-canvas");
        El.nodePanel = document.getElementById("eosholo-node-panel");

        Boot().catch((error) => {
            console.error("EoSHolo failed to start:", error);
            El.loadingMessage.textContent = "Failed to load EoSHolo. See console for details.";
        });
    });

    async function Boot() {
        El.loadingMessage.textContent = "Loading calibration network…";
        const Response = await fetch("/data/Calibration_Graph.json");
        if (!Response.ok) {
            throw new Error(`Failed to fetch Calibration_Graph.json: ${Response.status}`);
        }
        State.graph = await Response.json();

        Build_Indexes();
        await Load_Theme();
        Populate_Composition_Dropdown();
        Wire_Controls();
        Wire_Canvas();
        Observe_Theme_Changes();

        // Canvas text doesn't auto-redraw when a web font finishes loading
        // later (unlike normal DOM text), so explicitly wait for "Noto Sans"
        // before the first Draw() — otherwise labels stay stuck on the
        // fallback font even after it loads.
        try {
            await Promise.all([
                document.fonts.load('16px "Noto Sans"'),
                document.fonts.load('bold 16px "Noto Sans"'),
            ]);
        } catch (error) {
            console.warn("Could not preload Noto Sans for canvas text:", error);
        }

        El.loading.hidden = true;
        El.controls.hidden = false;
        El.graphContainer.hidden = false;
        Resize_Canvas();
        Reset_View();
        Draw();
    }

    // ── Indexing / graph helpers (mirrors EoSHolo.py's lookup/children/depth helpers) ──

    function Build_Indexes() {
        State.lookup.clear();
        State.childrenOf.clear();
        for (const node of State.graph.nodes) {
            State.lookup.set(node.node_id, node);
        }
        for (const node of State.graph.nodes) {
            for (const parentId of node.parent_node_ids || []) {
                if (!parentId) continue;
                if (!State.childrenOf.has(parentId)) {
                    State.childrenOf.set(parentId, []);
                }
                State.childrenOf.get(parentId).push(node.node_id);
            }
        }
        Compute_Depths();
    }

    function Compute_Depths() {
        State.depths.clear();
        const Compute = (nodeId, visiting) => {
            if (State.depths.has(nodeId)) return State.depths.get(nodeId);
            if (visiting.has(nodeId)) return 0;
            const node = State.lookup.get(nodeId);
            if (!node) return 0;
            if (node.is_special) {
                State.depths.set(nodeId, -1);
                return -1;
            }
            const nextVisiting = new Set(visiting);
            nextVisiting.add(nodeId);
            const validParents = (node.parent_node_ids || []).filter((pid) => {
                const parent = State.lookup.get(pid);
                return parent && !parent.is_special;
            });
            let depth = 0;
            if (validParents.length) {
                const parentDepths = validParents
                    .map((pid) => Compute(pid, nextVisiting))
                    .filter((d) => d >= 0);
                depth = parentDepths.length ? Math.max(...parentDepths) + 1 : 0;
            }
            State.depths.set(nodeId, depth);
            return depth;
        };
        for (const node of State.graph.nodes) {
            if (!node.is_special) Compute(node.node_id, new Set());
        }
    }

    function Get_Ancestors(nodeId) {
        // Root-first ancestor chain including nodeId itself. Mirrors Get_Study_Chain.
        if (!nodeId) return [];
        const visited = new Set();
        const chain = [];
        const traverse = (id) => {
            if (visited.has(id)) return;
            visited.add(id);
            const node = State.lookup.get(id);
            if (node) {
                for (const pid of node.parent_node_ids || []) {
                    if (pid) traverse(pid);
                }
            }
            chain.push(id);
        };
        traverse(nodeId);
        return chain;
    }

    function Get_Descendants(nodeId) {
        if (!nodeId) return new Set();
        const descendants = new Set();
        const stack = [...(State.childrenOf.get(nodeId) || [])];
        while (stack.length) {
            const id = stack.pop();
            if (descendants.has(id)) continue;
            descendants.add(id);
            stack.push(...(State.childrenOf.get(id) || []));
        }
        return descendants;
    }

    function Get_Chains_Through(nodeId) {
        if (!nodeId || !State.lookup.has(nodeId)) return new Set();
        const ancestors = new Set(Get_Ancestors(nodeId));
        const descendants = Get_Descendants(nodeId);
        return new Set([...ancestors, ...descendants]);
    }

    // ── Theme ────────────────────────────────────────────────────────────────

    async function Load_Theme() {
        const Response = await fetch("/Pyodide_Packages/Themes/theme.json");
        State.theme = await Response.json();
    }

    function Current_Colors() {
        const Mode = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
        return State.theme[Mode] || {};
    }

    function Observe_Theme_Changes() {
        const Observer = new MutationObserver(() => Draw());
        Observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }

    // ── Controls ─────────────────────────────────────────────────────────────
    // Make_Dropdown_Widget now lives in Dropdown_Widget.js (shared with the
    // EoSAlign page) — loaded as a separate <script> before this file.

    function Populate_Composition_Dropdown() {
        const Names = State.graph.composition_display_names;
        const Sorted = [...State.graph.compositions].sort((a, b) =>
            (Names[a] || a).localeCompare(Names[b] || b)
        );
        El.compositionDropdown.setOptions(Sorted.map((composition) => ({
            value: composition,
            label: Names[composition] || composition,
        })));
    }

    function Study_Sort_Key(label) {
        const separatorIndex = label.indexOf(" | ");
        const studyPart = separatorIndex >= 0 ? label.slice(0, separatorIndex) : label;
        const remainder = separatorIndex >= 0 ? label.slice(separatorIndex + 3) : "";
        const studyName = studyPart.replace(/\*/g, "").trim().toLowerCase();
        return [studyName, remainder.toLowerCase(), label.toLowerCase()];
    }

    function Compare_Study_Keys(a, b) {
        const keyA = Study_Sort_Key(a);
        const keyB = Study_Sort_Key(b);
        for (let i = 0; i < keyA.length; i++) {
            if (keyA[i] < keyB[i]) return -1;
            if (keyA[i] > keyB[i]) return 1;
        }
        return 0;
    }

    function Populate_Study_Dropdown(composition, selectLabel) {
        const Labels = [...new Set(
            State.graph.nodes
                .filter((n) => n.composition === composition && n.has_calibration)
                .map((n) => n.display_label)
        )].sort(Compare_Study_Keys);
        El.studyDropdown.setOptions(Labels.map((label) => ({ value: label, label })));
        if (selectLabel && Labels.includes(selectLabel)) {
            El.studyDropdown.value = selectLabel;
        }
        Update_Preview_Button_State();
    }

    function Get_Selected_Study_Entry() {
        const Composition = El.compositionDropdown.value;
        const Label = El.studyDropdown.value;
        if (!Composition || !Label) return null;
        return State.graph.nodes.find(
            (n) => n.composition === Composition && n.display_label === Label && n.has_calibration
        ) || null;
    }

    function Update_Preview_Button_State() {
        const Entry = Get_Selected_Study_Entry();
        const HasInfo = Boolean(Entry && Entry.info);
        El.previewButton.disabled = !HasInfo;
        El.previewButton.title = HasInfo
            ? `Preview the calibration details for ${Entry.study}`
            : (Entry ? "No calibration details available for the selected study." : "Select a study to preview its details.");
    }

    // Opens the read-only calibration view (Calibrant_Preview.html) in a new
    // tab — mirrors opening this calibration in
    // View_Edit_And_Save_Calibration_Files_In_A_New_Window.py's view mode.
    function Open_Calibrant_Preview(node) {
        if (!node || !node.info) return;
        window.open(`/calibrant-preview/?id=${encodeURIComponent(node.node_id)}`, "_blank");
    }

    function Wire_Controls() {
        El.compositionDropdown.addEventListener("change", () => {
            State.focusMode = "default";
            State.focusNodeId = null;
            Populate_Study_Dropdown(El.compositionDropdown.value, null);
            Hide_Node_Panel();
            Draw();
        });

        El.studyDropdown.addEventListener("change", () => {
            State.focusMode = "default";
            State.focusNodeId = null;
            Update_Preview_Button_State();
            Hide_Node_Panel();
            Draw();
        });

        El.showAllCheckbox.addEventListener("change", () => {
            State.focusMode = "default";
            State.focusNodeId = null;
            Hide_Node_Panel();
            Draw();
        });

        El.resetZoomButton.addEventListener("click", () => {
            Reset_View();
            Draw();
        });

        El.previewButton.addEventListener("click", () => Open_Calibrant_Preview(Get_Selected_Study_Entry()));

        // Covers every reason the graph container's rendered size can change --
        // a window resize, but also the controls bar growing/shrinking a few rows
        // when a study is selected (revealing the Preview Calibrant button) or the
        // "Show All Nodes" checkbox is toggled. A plain window "resize" listener
        // misses those, leaving the canvas at a stale size that no longer matches
        // its now-shrunk container -- the container clips the overflow via
        // overflow:hidden, but the graph is drawn assuming the old, larger size,
        // so its bottom portion ends up clipped from view.
        new ResizeObserver(() => { Resize_Canvas(); Draw(); }).observe(El.graphContainer);
    }

    // ── Focusing a node from the right-click panel ──────────────────────────

    function Focus_To_Node(nodeId) {
        State.focusMode = "to_node";
        State.focusNodeId = nodeId;
        Sync_Dropdowns_To_Node(nodeId);
        El.showAllCheckbox.checked = false;
        Hide_Node_Panel();
        Draw();
    }

    function Focus_Through_Node(nodeId) {
        State.focusMode = "through_node";
        State.focusNodeId = nodeId;
        Sync_Dropdowns_To_Node(nodeId);
        El.showAllCheckbox.checked = false;
        Hide_Node_Panel();
        Draw();
    }

    function Sync_Dropdowns_To_Node(nodeId) {
        const Entry = State.lookup.get(nodeId);
        if (!Entry || !Entry.has_calibration) return;
        El.compositionDropdown.value = Entry.composition;
        Populate_Study_Dropdown(Entry.composition, Entry.display_label);
    }

    // ── Layout + drawing ─────────────────────────────────────────────────────

    function Get_Selected_Node_Id() {
        if (State.focusNodeId) return State.focusNodeId;
        const Entry = Get_Selected_Study_Entry();
        return Entry ? Entry.node_id : null;
    }

    function Compute_Visible_And_Chain_Ids() {
        const SelectedNodeId = Get_Selected_Node_Id();
        const ShowAll = El.showAllCheckbox.checked;

        let chainIds = new Set();
        let throughDescendantIds = new Set();
        let visibleIds;

        if (State.focusMode === "through_node" && SelectedNodeId) {
            const chainsThrough = Get_Chains_Through(SelectedNodeId);
            chainIds = chainsThrough;
            throughDescendantIds = Get_Descendants(SelectedNodeId);
            visibleIds = chainsThrough;
        } else if (State.focusMode === "to_node" && SelectedNodeId) {
            const ancestors = new Set(Get_Ancestors(SelectedNodeId));
            chainIds = ancestors;
            visibleIds = ancestors;
        } else if (ShowAll || !SelectedNodeId) {
            visibleIds = new Set(State.graph.nodes.map((n) => n.node_id));
            if (SelectedNodeId) chainIds = new Set(Get_Ancestors(SelectedNodeId));
        } else {
            const ancestors = new Set(Get_Ancestors(SelectedNodeId));
            chainIds = ancestors;
            visibleIds = ancestors;
        }

        return { selectedNodeId: SelectedNodeId, visibleIds, chainIds, throughDescendantIds };
    }

    function Resolve_Node_Class(nodeId, ctx) {
        if (nodeId === ctx.selectedNodeId) return "selected";
        const node = State.lookup.get(nodeId);
        if (node.is_special) return node.special_type === "absolute" ? "absolute" : "not_specified";
        if (State.focusMode === "through_node" && ctx.throughDescendantIds.has(nodeId)) return "through_child";
        if (!node.has_calibration) return "missing";
        if (ctx.chainIds.has(nodeId)) return "chain";
        return "normal";
    }

    // ── Layout helpers (ported from EoSHolo.py's Update_Graph) ──────────────

    // Deterministic per-node horizontal jitter within a column, mirrors
    // Stable_Unit_Float — same node+composition always jitters to the same
    // spot, so a node's X never moves except when its column changes.
    function Stable_Unit_Float(seed) {
        let hash = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            hash ^= seed.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0) / 4294967296;
    }

    // Mirrors "Build ordered composition list — Not Specified always last."
    function Compute_Element_Order() {
        const regular = State.graph.compositions.filter((c) => c !== "Not Specified").sort();
        return State.graph.compositions.includes("Not Specified") ? [...regular, "Not Specified"] : regular;
    }

    // Column labels use the raw composition code (e.g. "Al2O3"), not the
    // Composition dropdown's friendly Display_Name — matches the desktop app.
    function Format_Composition_Label(label) {
        const words = (label || "").split(/\s+/).filter(Boolean);
        return words.length === 2 ? `${words[0]}\n${words[1]}` : label;
    }

    function Measure_Widest_Word_Width(ctx2d, words, fontSizePx) {
        ctx2d.font = `bold ${fontSizePx}px "Noto Sans", Arial, sans-serif`;
        let widest = 0;
        for (const word of words) {
            widest = Math.max(widest, ctx2d.measureText(word).width);
        }
        return widest;
    }

    // Binary-search the largest column-label font size (capped at 20) whose
    // widest single word — across ALL composition names, not just the
    // currently visible ones — still fits the visible column width.
    function Compute_Column_Label_Font_Size(ctx2d, compositionNames, targetWidth) {
        const words = [];
        for (const name of compositionNames) {
            const parts = (name || "").split(/\s+/).filter(Boolean);
            if (parts.length) words.push(...parts);
            else if (name) words.push(name);
        }
        if (!words.length || targetWidth <= 0) return 9;

        const widthAt = (size) => Measure_Widest_Word_Width(ctx2d, words, size);
        let low = 1;
        let high = MAX_COLUMN_LABEL_FONT_SIZE;
        if (widthAt(high) <= targetWidth) return high;
        if (widthAt(low) >= targetWidth) return low;
        for (let i = 0; i < 24; i++) {
            const mid = (low + high) / 2;
            if (widthAt(mid) <= targetWidth) low = mid;
            else high = mid;
        }
        return low;
    }

    // Recomputes ancestor depths over only the visible subset, mirroring the
    // "Recompute depths for the visible subset when filtered" block.
    function Compute_Visible_Depths(visibleIds) {
        const depths = new Map();
        const visLookup = (id) => (visibleIds.has(id) ? State.lookup.get(id) : null);

        const compute = (nodeId, visiting) => {
            if (depths.has(nodeId)) return depths.get(nodeId);
            if (visiting.has(nodeId)) return 0;
            const node = visLookup(nodeId);
            if (node && node.is_special) {
                depths.set(nodeId, -1);
                return -1;
            }
            if (!node || !(node.parent_node_ids || []).length) {
                depths.set(nodeId, 0);
                return 0;
            }
            const nextVisiting = new Set(visiting);
            nextVisiting.add(nodeId);
            const validParents = node.parent_node_ids.filter((pid) => {
                const parent = visLookup(pid);
                return parent && !parent.is_special;
            });
            let depth = 0;
            if (validParents.length) {
                const parentDepths = validParents.map((pid) => compute(pid, nextVisiting)).filter((d) => d >= 0);
                depth = parentDepths.length ? Math.max(...parentDepths) + 1 : 0;
            }
            depths.set(nodeId, depth);
            return depth;
        };

        for (const nodeId of visibleIds) {
            const node = State.lookup.get(nodeId);
            if (node && !node.is_special) compute(nodeId, new Set());
        }
        return depths;
    }

    function Get_Node_Label_Text(nodeId) {
        const node = State.lookup.get(nodeId);
        if (node.is_special && node.special_type === "absolute") return `${node.study} (Absolute)`;
        return node.study;
    }

    // Mirrors NodeItem.boundingRect() exactly (symbol + label band + the
    // antialias/shadow repaint padding), since later clamping uses it to keep
    // a whole node (symbol and label) inside its composition column.
    function Node_Bounding_Box(radius, labelWidthPx, labelHeightPx) {
        const pad = 4;
        const aaPad = 10;
        let left = -(radius + 4);
        let top = -(radius + 4);
        let right = radius + 4;
        let bottom = radius + 4;

        const lx = -(labelWidthPx + 2 * pad) / 2;
        const ly = radius + 8;
        const lright = lx + labelWidthPx + 2 * pad;
        const lbot = ly + labelHeightPx + 2 * pad;
        left = Math.min(left, lx);
        right = Math.max(right, lright);
        bottom = Math.max(bottom, lbot);

        return { left: left - aaPad, top: top - aaPad, right: right + aaPad, bottom: bottom + aaPad };
    }

    function Node_Sort_Key(nodeId, depths, colIndex) {
        const node = State.lookup.get(nodeId);
        return [depths.get(nodeId) ?? 0, colIndex.get(node.composition) ?? 1e6, node.study || "", nodeId];
    }

    function Compare_Node_Sort_Keys(a, b) {
        for (let i = 0; i < a.length; i++) {
            if (a[i] < b[i]) return -1;
            if (a[i] > b[i]) return 1;
        }
        return 0;
    }

    // Topological (Kahn's algorithm) ordering of regular nodes by parent ->
    // child dependency, ties broken by (depth, column, study, id). Mirrors
    // _order_regular_nodes, used for the global-row layout when there are
    // fewer than 50 visible nodes (a focused/filtered view).
    function Order_Regular_Nodes(nodeIds, depths, colIndex) {
        const nodeSet = new Set(nodeIds);
        if (!nodeSet.size) return [];

        const indegree = new Map();
        const children = new Map();
        for (const nid of nodeSet) {
            indegree.set(nid, 0);
            children.set(nid, []);
        }
        for (const nid of nodeSet) {
            for (const pid of State.lookup.get(nid).parent_node_ids || []) {
                if (nodeSet.has(pid)) {
                    indegree.set(nid, indegree.get(nid) + 1);
                    children.get(pid).push(nid);
                }
            }
        }

        const sortKey = (nid) => Node_Sort_Key(nid, depths, colIndex);
        const ready = [...nodeSet].filter((nid) => indegree.get(nid) === 0);
        ready.sort((a, b) => Compare_Node_Sort_Keys(sortKey(a), sortKey(b)));

        const ordered = [];
        while (ready.length) {
            const nid = ready.shift();
            ordered.push(nid);
            for (const cid of children.get(nid) || []) {
                indegree.set(cid, indegree.get(cid) - 1);
                if (indegree.get(cid) === 0) ready.push(cid);
            }
            ready.sort((a, b) => Compare_Node_Sort_Keys(sortKey(a), sortKey(b)));
        }

        // Cycle safety fallback.
        const orderedSet = new Set(ordered);
        const remaining = [...nodeSet].filter((nid) => !orderedSet.has(nid));
        if (remaining.length) {
            remaining.sort((a, b) => Compare_Node_Sort_Keys(sortKey(a), sortKey(b)));
            ordered.push(...remaining);
        }
        return ordered;
    }

    // Evenly spaces nodes within a vertical zone with gaps between them —
    // mirrors _place_nodes, used by the >=50-visible-node (typically "Show
    // All") per-column placement branch.
    function Place_Nodes_In_Zone(nodeIds, zoneTop, zoneH, gapSize, nodeY) {
        const n = nodeIds.length;
        if (n === 0) return;
        if (n === 1) {
            nodeY.set(nodeIds[0], zoneTop + zoneH / 2);
            return;
        }
        const totalGap = gapSize * (n - 1);
        const sectionH = (zoneH - totalGap) / n;
        nodeIds.forEach((nid, i) => {
            nodeY.set(nid, zoneTop + i * (sectionH + gapSize) + sectionH / 2);
        });
    }

    // Mirrors _node_y_limits: the min/max Y this specific node (its own
    // radius + label) can sit at while staying fully inside its column.
    function Get_Node_Y_Limits(nodeId, ctx, colBounds, nodeBaseRadius, nodeLabelFontSize, ctx2d) {
        const node = State.lookup.get(nodeId);
        const bounds = colBounds.get(node.composition);
        if (!bounds) return [0, 0];

        const nodeClass = Resolve_Node_Class(nodeId, ctx);
        const radius = nodeBaseRadius * NODE_STYLES[nodeClass].radiusScale;
        const labelText = Get_Node_Label_Text(nodeId);
        ctx2d.font = `${nodeLabelFontSize}px "Noto Sans", Arial, sans-serif`;
        const labelWidth = ctx2d.measureText(labelText).width;
        const labelPixelHeight = nodeLabelFontSize * FONT_HEIGHT_MULTIPLIER;
        const box = Node_Bounding_Box(radius, labelWidth, labelPixelHeight);

        const minY = bounds.top - box.top;
        const maxY = bounds.bottom - box.bottom;
        if (minY > maxY) {
            const mid = (minY + maxY) / 2;
            return [mid, mid];
        }
        return [minY, maxY];
    }

    // Mirrors _respread_column_nodes: a post-pass that spreads nodes sharing
    // a column by at least 1.5 node-diameters, pinning absolute/"primary"
    // nodes to the top and not-specified nodes to the bottom.
    function Respread_Column_Nodes(nodeIds, minStep, yMin, yMax, ctx, colBounds, nodeY, nodeBaseRadius, nodeLabelFontSize, ctx2d) {
        const ordered = [...nodeIds].filter((nid) => nodeY.has(nid)).sort((a, b) => nodeY.get(a) - nodeY.get(b));
        if (ordered.length < 2) return;

        const primary = [];
        const ns = [];
        for (const nid of ordered) {
            const node = State.lookup.get(nid);
            if (node.is_special && node.special_type === "absolute") primary.push(nid);
            else if (node.is_special && node.special_type === "not_specified") ns.push(nid);
        }

        const yLimits = (nid) => Get_Node_Y_Limits(nid, ctx, colBounds, nodeBaseRadius, nodeLabelFontSize, ctx2d);

        const fixed = new Map();
        primary.forEach((nid, idx) => {
            const [nmin, nmax] = yLimits(nid);
            const anchor = yMin + idx * minStep;
            fixed.set(nid, Math.min(Math.max(anchor, nmin), nmax));
        });
        const nNs = ns.length;
        ns.forEach((nid, idx) => {
            const [nmin, nmax] = yLimits(nid);
            const anchor = yMax - (nNs - 1 - idx) * minStep;
            fixed.set(nid, Math.min(Math.max(anchor, nmin), nmax));
        });

        const sequence = ordered;
        const y = new Map();
        for (const nid of sequence) {
            const [nmin, nmax] = yLimits(nid);
            const baseY = fixed.has(nid) ? fixed.get(nid) : nodeY.get(nid);
            y.set(nid, Math.min(Math.max(baseY, nmin), nmax));
        }

        const nodeLen = (nid) => {
            const nodeClass = Resolve_Node_Class(nid, ctx);
            return Math.max(1, nodeBaseRadius * NODE_STYLES[nodeClass].radiusScale * 2);
        };
        const pairGap = (prevId, curId) => Math.max(minStep, 1.5 * Math.max(nodeLen(prevId), nodeLen(curId)));

        for (let i = 0; i < sequence.length; i++) {
            const nid = sequence[i];
            if (fixed.has(nid)) { y.set(nid, fixed.get(nid)); continue; }
            if (i > 0) {
                const prev = sequence[i - 1];
                const gap = pairGap(prev, nid);
                const [nmin, nmax] = yLimits(nid);
                const candidate = Math.max(y.get(nid), y.get(prev) + gap);
                y.set(nid, Math.min(Math.max(candidate, nmin), nmax));
            }
        }
        for (let i = sequence.length - 1; i >= 0; i--) {
            const nid = sequence[i];
            if (fixed.has(nid)) { y.set(nid, fixed.get(nid)); continue; }
            if (i < sequence.length - 1) {
                const next = sequence[i + 1];
                const gap = pairGap(nid, next);
                const [nmin, nmax] = yLimits(nid);
                const candidate = Math.min(y.get(nid), y.get(next) - gap);
                y.set(nid, Math.min(Math.max(candidate, nmin), nmax));
            }
        }

        for (const nid of sequence) {
            nodeY.set(nid, y.get(nid));
        }
    }

    function Compute_Layout(ctx2d, visibleIds, ctx, SW, SH) {
        const elementOrder = Compute_Element_Order();
        const visComps = new Set([...visibleIds].map((id) => State.lookup.get(id).composition));
        const filtOrder = elementOrder.filter((c) => visComps.has(c));
        const numVisCols = filtOrder.length;

        const padH = SH * PAD_H_FRAC;
        const padW = SW * PAD_W_FRAC;
        const availableH = SH - 2 * padH;
        const availableW = SW - 2 * padW;

        let visRectW;
        let visColW;
        if (numVisCols > 0) {
            const colGapW = SW * H_GAP_FRAC;
            const totalInterColGap = colGapW * (numVisCols - 1);
            const widthForCols = Math.max(availableW - totalInterColGap, 0);
            visRectW = widthForCols / numVisCols;
            visColW = visRectW + colGapW;
        } else {
            visRectW = availableW;
            visColW = availableW;
        }

        // Column label font size: fit the widest single word across ALL
        // composition names (not just the currently visible ones) into the
        // visible column width, capped at 20.
        const labelFontSize = Compute_Column_Label_Font_Size(ctx2d, elementOrder, visRectW);
        const visibleLabels = filtOrder.map(Format_Composition_Label);
        const maxLabelLines = visibleLabels.length
            ? Math.max(...visibleLabels.map((l) => l.split("\n").length))
            : 1;
        const labelHeight = Math.max(26, labelFontSize * FONT_HEIGHT_MULTIPLIER * maxLabelLines + 6);

        const rectH = availableH;
        const nodeAreaTop = padH + labelHeight;
        const nodeAreaH = Math.max(0, rectH - labelHeight);
        const nodeInset = Math.max(4, nodeAreaH * 0.005);
        const placeAreaTop = nodeAreaTop + nodeInset;
        const placeAreaH = Math.max(0, nodeAreaH - 2 * nodeInset);

        const primZoneH = placeAreaH * 0.05;
        const regZoneH = placeAreaH * 0.90;
        const nsZoneH = placeAreaH * 0.05;
        const vGapSize = placeAreaH * V_GAP_FRAC;

        // Node + label sizing tracks the column label size, per the app's
        // "adaptive shared sizing rules."
        const columnLabelScale = Math.min(1, Math.max(0, labelFontSize / MAX_COLUMN_LABEL_FONT_SIZE));
        const nodeLabelFontSize = Math.max(1, Math.min(labelFontSize, MAX_NODE_LABEL_FONT_SIZE));
        const nodeLabelPixelHeight = nodeLabelFontSize * FONT_HEIGHT_MULTIPLIER;
        const maxNodeSizeByHeight = Math.max(4, nodeAreaH - (40 + nodeLabelPixelHeight));
        const nodeDiameter = Math.max(
            4,
            Math.min(visRectW * 0.5, MAX_NODE_DIAMETER * columnLabelScale, maxNodeSizeByHeight)
        );
        const nodeBaseRadius = nodeDiameter / 2;

        // Per-column placement bounds (the area below the label band) used to
        // clamp every node fully inside its own composition column.
        const colBounds = new Map();
        filtOrder.forEach((composition, index) => {
            const left = padW + index * visColW;
            colBounds.set(composition, {
                left,
                right: left + visRectW,
                top: nodeAreaTop,
                bottom: nodeAreaTop + nodeAreaH,
            });
        });

        // Group visible node ids by composition, sorted Primary -> Regular(by
        // depth) -> Not Specified, mirroring _sort_group.
        const elemGroups = new Map(filtOrder.map((c) => [c, []]));
        for (const nodeId of visibleIds) {
            const composition = State.lookup.get(nodeId).composition;
            if (elemGroups.has(composition)) elemGroups.get(composition).push(nodeId);
        }

        const showAll = El.showAllCheckbox.checked;
        const depths = (!showAll && ctx.selectedNodeId) ? Compute_Visible_Depths(visibleIds) : State.depths;

        const sortGroup = (nodeIds) => {
            const primary = [];
            const regular = [];
            const notSpecified = [];
            for (const nid of nodeIds) {
                const node = State.lookup.get(nid);
                if (node.is_special) {
                    (node.special_type === "absolute" ? primary : notSpecified).push(nid);
                } else {
                    regular.push(nid);
                }
            }
            regular.sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
            return [...primary, ...regular, ...notSpecified];
        };
        for (const composition of elemGroups.keys()) {
            elemGroups.set(composition, sortGroup(elemGroups.get(composition)));
        }

        // ── Each visible node's Y position. X is always recomputed by the
        // deterministic jitter pass below regardless of which branch ran
        // here — this mirrors EoSHolo.py exactly: dragging a node only ever
        // persists its Y, never its X. ──
        const nodeY = new Map();
        const visibleCount = visibleIds.size;

        if (visibleCount > 0 && visibleCount < GLOBAL_ROW_NODE_COUNT_THRESHOLD) {
            const colIndex = new Map(filtOrder.map((c, i) => [c, i]));
            const primaryNodes = [];
            const regularNodes = [];
            const nsNodes = [];
            for (const composition of filtOrder) {
                for (const nid of elemGroups.get(composition) || []) {
                    const node = State.lookup.get(nid);
                    if (node.is_special && node.special_type === "absolute") primaryNodes.push(nid);
                    else if (node.is_special && node.special_type === "not_specified") nsNodes.push(nid);
                    else regularNodes.push(nid);
                }
            }
            const sortKey = (nid) => Node_Sort_Key(nid, depths, colIndex);
            const primaryOrder = [...primaryNodes].sort((a, b) => Compare_Node_Sort_Keys(sortKey(a), sortKey(b)));
            const regularOrder = Order_Regular_Nodes(regularNodes, depths, colIndex);
            const nsOrder = [...nsNodes].sort((a, b) => Compare_Node_Sort_Keys(sortKey(a), sortKey(b)));
            const allOrder = [...primaryOrder, ...regularOrder, ...nsOrder];

            const n = allOrder.length;
            if (n === 1) {
                nodeY.set(allOrder[0], placeAreaTop + placeAreaH / 2);
            } else if (n > 1) {
                const step = placeAreaH / (n - 1);
                allOrder.forEach((nid, i) => nodeY.set(nid, placeAreaTop + i * step));
            }

            // Post-pass: spread same-column nodes by >= 1.5 node diameters.
            const minSameColStep = 1.5 * Math.max(1, nodeBaseRadius * 2);
            for (const composition of filtOrder) {
                const colNodes = (elemGroups.get(composition) || []).filter((nid) => nodeY.has(nid));
                if (colNodes.length > 1) {
                    Respread_Column_Nodes(
                        colNodes, minSameColStep, placeAreaTop, placeAreaTop + placeAreaH,
                        ctx, colBounds, nodeY, nodeBaseRadius, nodeLabelFontSize, ctx2d
                    );
                }
            }
        } else {
            for (const composition of filtOrder) {
                const nodesIn = elemGroups.get(composition) || [];
                const primaryNs = nodesIn.filter((nid) => {
                    const node = State.lookup.get(nid);
                    return node.is_special && node.special_type === "absolute";
                });
                const regularNs = nodesIn.filter((nid) => !State.lookup.get(nid).is_special);
                const nsNodes = nodesIn.filter((nid) => {
                    const node = State.lookup.get(nid);
                    return node.is_special && node.special_type === "not_specified";
                });
                Place_Nodes_In_Zone(primaryNs, placeAreaTop, primZoneH, vGapSize, nodeY);
                Place_Nodes_In_Zone(regularNs, placeAreaTop + primZoneH, regZoneH, vGapSize, nodeY);
                Place_Nodes_In_Zone(nsNodes, placeAreaTop + primZoneH + regZoneH, nsZoneH, vGapSize, nodeY);
            }
        }

        // ── If the user has dragged a node, both X and Y persist as-is.
        // Otherwise X falls back to a deterministic per-node jitter (or
        // column center for narrow columns) and Y to the computed layout.
        // Both are then clamped fully inside the node's composition column. ──
        const positions = new Map();
        for (const nodeId of visibleIds) {
            const node = State.lookup.get(nodeId);
            const bounds = colBounds.get(node.composition);
            if (!bounds) continue;

            const nodeClass = Resolve_Node_Class(nodeId, ctx);
            const radius = nodeBaseRadius * NODE_STYLES[nodeClass].radiusScale;
            const labelText = Get_Node_Label_Text(nodeId);
            ctx2d.font = `${nodeLabelFontSize}px "Noto Sans", Arial, sans-serif`;
            const labelWidth = ctx2d.measureText(labelText).width;
            const box = Node_Bounding_Box(radius, labelWidth, nodeLabelPixelHeight);

            const manualPos = State.manualPositions.get(nodeId);

            let x;
            if (manualPos) {
                x = manualPos.x;
            } else {
                x = (bounds.left + bounds.right) / 2;
                const nodeWidth = Math.max(1, radius * 2);
                const colW = Math.max(0, bounds.right - bounds.left);
                if (colW > 3 * nodeWidth) {
                    const midLeft = bounds.left + 0.15 * colW;
                    const midRight = bounds.right - 0.15 * colW;
                    if (midRight > midLeft) {
                        const u = Stable_Unit_Float(`${nodeId}|${node.composition}`);
                        x = midLeft + u * (midRight - midLeft);
                    }
                }
            }

            let y = manualPos
                ? manualPos.y
                : (nodeY.get(nodeId) ?? (bounds.top + bounds.bottom) / 2);

            const minX = bounds.left - box.left;
            const maxX = bounds.right - box.right;
            const minY = bounds.top - box.top;
            const maxY = bounds.bottom - box.bottom;
            if (minX <= maxX) x = Math.min(Math.max(x, minX), maxX);
            if (minY <= maxY) y = Math.min(Math.max(y, minY), maxY);

            positions.set(nodeId, { x, y, radius, nodeClass, labelText });
        }

        const columns = filtOrder.map((composition) => ({
            composition,
            left: colBounds.get(composition).left,
            width: visRectW,
        }));

        return {
            positions,
            columns,
            padH,
            rectH,
            labelHeight,
            labelFontSize,
            nodeBaseRadius,
            nodeLabelFontSize,
        };
    }

    // Theme colors are plain "#RRGGBB" hex; canvas needs rgba() for alpha.
    function Hex_To_Rgba(hex, alpha) {
        const clean = (hex || "#000000").replace("#", "");
        const expanded = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
        const value = parseInt(expanded, 16);
        const r = (value >> 16) & 255;
        const g = (value >> 8) & 255;
        const b = value & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function Draw_Rounded_Rect_Path(ctx2d, x, y, width, height, radius) {
        const r = Math.max(0, Math.min(radius, width / 2, height / 2));
        ctx2d.beginPath();
        ctx2d.moveTo(x + r, y);
        ctx2d.arcTo(x + width, y, x + width, y + height, r);
        ctx2d.arcTo(x + width, y + height, x, y + height, r);
        ctx2d.arcTo(x, y + height, x, y, r);
        ctx2d.arcTo(x, y, x + width, y, r);
        ctx2d.closePath();
    }

    function Resize_Canvas() {
        const Ratio = window.devicePixelRatio || 1;
        const Rect = El.graphContainer.getBoundingClientRect();
        El.canvas.width = Math.max(1, Math.round(Rect.width * Ratio));
        El.canvas.height = Math.max(1, Math.round(Rect.height * Ratio));
        El.canvas.style.width = `${Rect.width}px`;
        El.canvas.style.height = `${Rect.height}px`;
    }

    function Reset_View() {
        State.view = { x: 0, y: 0, scale: 1 };
    }

    function World_To_Screen(point) {
        const Ratio = window.devicePixelRatio || 1;
        return {
            x: (point.x * State.view.scale + State.view.x) * Ratio,
            y: (point.y * State.view.scale + State.view.y) * Ratio,
        };
    }

    // Inverse of World_To_Screen, operating in CSS pixels (not device pixels).
    function Css_Point_To_World(cssX, cssY) {
        return {
            x: (cssX - State.view.x) / State.view.scale,
            y: (cssY - State.view.y) / State.view.scale,
        };
    }

    function Draw() {
        if (!El.canvas.width || !El.canvas.height) return;
        const Colors = Current_Colors();
        const ctx2d = El.canvas.getContext("2d");
        const Ratio = window.devicePixelRatio || 1;

        ctx2d.save();
        ctx2d.clearRect(0, 0, El.canvas.width, El.canvas.height);
        ctx2d.fillStyle = Colors.Primary_Background || "#ffffff";
        ctx2d.fillRect(0, 0, El.canvas.width, El.canvas.height);

        const Context = Compute_Visible_And_Chain_Ids();
        const CssWidth = El.canvas.width / Ratio;
        const CssHeight = El.canvas.height / Ratio;
        const Layout = Compute_Layout(ctx2d, Context.visibleIds, Context, CssWidth, CssHeight);
        State.lastLayout = Layout.positions;
        State.lastNodeBaseRadius = Layout.nodeBaseRadius;

        const WorldPos = (nodeId) => Layout.positions.get(nodeId) || null;

        // Composition column backgrounds, drawn first so everything else sits
        // on top — mirrors EoSHolo.py's BackgroundItem (one per composition).
        for (const column of Layout.columns) {
            const TopLeftScreen = World_To_Screen({ x: column.left, y: Layout.padH });
            const BottomRightScreen = World_To_Screen({ x: column.left + column.width, y: Layout.padH + Layout.rectH });
            const LabelBandHeight = Layout.labelHeight * State.view.scale * Ratio;
            const RectX = TopLeftScreen.x;
            const RectY = TopLeftScreen.y + LabelBandHeight;
            const RectWidth = BottomRightScreen.x - TopLeftScreen.x;
            const RectHeight = BottomRightScreen.y - RectY;

            if (RectWidth > 0 && RectHeight > 0) {
                ctx2d.fillStyle = Colors.Quinary_Text || "#9e9e9e";
                ctx2d.globalAlpha = 0.18;
                Draw_Rounded_Rect_Path(ctx2d, RectX, RectY, RectWidth, RectHeight, 10 * Ratio);
                ctx2d.fill();
                ctx2d.globalAlpha = 1;
            }

            const LabelLines = Format_Composition_Label(column.composition).split("\n");
            ctx2d.fillStyle = Colors.Quinary_Text || "#9e9e9e";
            ctx2d.font = `bold ${Layout.labelFontSize * State.view.scale * Ratio}px "Noto Sans", Arial, sans-serif`;
            ctx2d.textAlign = "center";
            ctx2d.textBaseline = "middle";
            const LineHeight = LabelBandHeight / LabelLines.length;
            LabelLines.forEach((line, i) => {
                ctx2d.fillText(line, TopLeftScreen.x + RectWidth / 2, TopLeftScreen.y + LineHeight * (i + 0.5));
            });
            ctx2d.textBaseline = "alphabetic";
        }

        // Edges, trimmed away from node circles by source/target gaps —
        // mirrors EdgeItem's source_gap/target_gap.
        for (const nodeId of Context.visibleIds) {
            const node = State.lookup.get(nodeId);
            const childPos = WorldPos(nodeId);
            if (!childPos) continue;
            for (const parentId of node.parent_node_ids || []) {
                if (!Context.visibleIds.has(parentId)) continue;
                const parentPos = WorldPos(parentId);
                if (!parentPos) continue;
                const isChainEdge = Context.chainIds.has(nodeId) && Context.chainIds.has(parentId);
                const style = isChainEdge ? EDGE_STYLE_CHAIN : EDGE_STYLE_NORMAL;
                const screenA = World_To_Screen(parentPos);
                const screenB = World_To_Screen(childPos);
                const dx = screenB.x - screenA.x;
                const dy = screenB.y - screenA.y;
                const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                const ux = dx / dist;
                const uy = dy / dist;
                const sourceGap = EDGE_SOURCE_GAP * State.view.scale * Ratio;
                const targetGap = EDGE_TARGET_GAP * State.view.scale * Ratio;

                ctx2d.strokeStyle = Colors[style.colorKey] || "#888888";
                ctx2d.lineWidth = style.width * State.view.scale * Ratio;
                ctx2d.beginPath();
                ctx2d.moveTo(screenA.x + ux * sourceGap, screenA.y + uy * sourceGap);
                ctx2d.lineTo(screenB.x - ux * targetGap, screenB.y - uy * targetGap);
                ctx2d.stroke();
            }
        }

        // Nodes, ordered so 'selected' draws last (on top).
        const DrawOrder = [...Context.visibleIds].sort((a, b) => {
            const aSelected = a === Context.selectedNodeId ? 1 : 0;
            const bSelected = b === Context.selectedNodeId ? 1 : 0;
            return aSelected - bSelected;
        });

        for (const nodeId of DrawOrder) {
            const pos = WorldPos(nodeId);
            if (!pos) continue;
            const style = NODE_STYLES[pos.nodeClass];
            const screenPos = World_To_Screen(pos);
            const radius = pos.radius * State.view.scale * Ratio;
            const fillColor = Colors[style.fillKey] || "#999999";

            Draw_Node_Shape(ctx2d, style.shape, screenPos.x, screenPos.y, radius, fillColor);

            // Label sits on a semi-transparent rounded-rect background —
            // mirrors NodeItem.paint()'s pad=4, alpha=220/255 label box.
            const labelFontPx = Layout.nodeLabelFontSize * State.view.scale * Ratio;
            ctx2d.font = `${labelFontPx}px "Noto Sans", Arial, sans-serif`;
            const labelWidth = ctx2d.measureText(pos.labelText).width;
            const labelTextHeight = labelFontPx * FONT_HEIGHT_MULTIPLIER;
            const labelPad = 4 * State.view.scale * Ratio;
            const boxWidth = labelWidth + 2 * labelPad;
            const boxHeight = labelTextHeight + 2 * labelPad;
            const boxX = screenPos.x - boxWidth / 2;
            const boxY = screenPos.y + radius + 8 * State.view.scale * Ratio;

            ctx2d.fillStyle = Hex_To_Rgba(Colors.Tertiary_Background, 220 / 255);
            Draw_Rounded_Rect_Path(ctx2d, boxX, boxY, boxWidth, boxHeight, 4 * State.view.scale * Ratio);
            ctx2d.fill();

            ctx2d.fillStyle = Colors.Secondary_Text || "#000000";
            ctx2d.textAlign = "center";
            ctx2d.textBaseline = "middle";
            ctx2d.fillText(pos.labelText, screenPos.x, boxY + boxHeight / 2);
            ctx2d.textBaseline = "alphabetic";
        }

        ctx2d.restore();
    }

    function Draw_Node_Shape(ctx2d, shape, x, y, r, fillColor) {
        ctx2d.fillStyle = fillColor;
        ctx2d.beginPath();
        if (shape === "ellipse") {
            ctx2d.arc(x, y, r, 0, Math.PI * 2);
        } else if (shape === "square") {
            ctx2d.rect(x - r, y - r, r * 2, r * 2);
        } else if (shape === "diamond") {
            ctx2d.moveTo(x, y - r);
            ctx2d.lineTo(x + r, y);
            ctx2d.lineTo(x, y + r);
            ctx2d.lineTo(x - r, y);
            ctx2d.closePath();
        } else if (shape === "triangle") {
            ctx2d.moveTo(x, y - r);
            ctx2d.lineTo(x + r, y + r);
            ctx2d.lineTo(x - r, y + r);
            ctx2d.closePath();
        } else if (shape === "star") {
            const spikes = 5;
            const outerR = r;
            const innerR = r * 0.45;
            for (let i = 0; i < spikes * 2; i++) {
                const radius = i % 2 === 0 ? outerR : innerR;
                const angle = (Math.PI / spikes) * i - Math.PI / 2;
                const px = x + Math.cos(angle) * radius;
                const py = y + Math.sin(angle) * radius;
                if (i === 0) ctx2d.moveTo(px, py);
                else ctx2d.lineTo(px, py);
            }
            ctx2d.closePath();
        }
        ctx2d.fill();
    }

    // ── Canvas interaction: pan, zoom, drag node, click/right-click ────────

    function Wire_Canvas() {
        let isPanning = false;
        let isDraggingNode = false;
        let draggedNodeId = null;
        let lastCssPoint = { x: 0, y: 0 };
        let downCssPoint = { x: 0, y: 0 };
        let moved = false;

        const CssPoint = (event) => {
            const rect = El.canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        const Find_Node_At = (cssPoint) => {
            if (!State.lastLayout) return null;
            const world = Css_Point_To_World(cssPoint.x, cssPoint.y);

            let closest = null;
            let closestDist = Infinity;
            for (const [nodeId, pos] of State.lastLayout) {
                const dx = world.x - pos.x;
                const dy = world.y - pos.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const hitRadius = pos.radius + 6;
                if (dist <= hitRadius && dist < closestDist) {
                    closest = nodeId;
                    closestDist = dist;
                }
            }
            return closest;
        };

        El.canvas.addEventListener("mousedown", (event) => {
            Hide_Node_Panel();
            const cssPoint = CssPoint(event);
            downCssPoint = cssPoint;
            lastCssPoint = cssPoint;
            moved = false;
            const hitNodeId = Find_Node_At(cssPoint);
            if (hitNodeId) {
                isDraggingNode = true;
                draggedNodeId = hitNodeId;
            } else {
                isPanning = true;
                El.canvas.classList.add("dragging");
            }
        });

        window.addEventListener("mousemove", (event) => {
            if (!isPanning && !isDraggingNode) return;
            const cssPoint = CssPoint(event);
            const dx = cssPoint.x - lastCssPoint.x;
            const dy = cssPoint.y - lastCssPoint.y;
            if (Math.abs(cssPoint.x - downCssPoint.x) > 3 || Math.abs(cssPoint.y - downCssPoint.y) > 3) {
                moved = true;
            }

            if (isDraggingNode && draggedNodeId) {
                // Both X and Y persist past this drag; Compute_Layout only
                // falls back to the deterministic per-node jitter for nodes
                // that have never been manually moved.
                const world = Css_Point_To_World(cssPoint.x, cssPoint.y);
                State.manualPositions.set(draggedNodeId, { x: world.x, y: world.y });
                Draw();
            } else if (isPanning) {
                State.view.x += dx;
                State.view.y += dy;
                Draw();
            }
            lastCssPoint = cssPoint;
        });

        window.addEventListener("mouseup", () => {
            // A plain click (mousedown+mouseup with no movement) on a node is
            // intentionally a no-op — only dragging moves a node, and only
            // right-click opens the info panel (see contextmenu below).
            isPanning = false;
            isDraggingNode = false;
            draggedNodeId = null;
            El.canvas.classList.remove("dragging");
        });

        El.canvas.addEventListener("wheel", (event) => {
            event.preventDefault();
            const cssPoint = CssPoint(event);
            const worldBefore = Css_Point_To_World(cssPoint.x, cssPoint.y);
            const zoomFactor = Math.exp(-event.deltaY * 0.001);
            State.view.scale = Math.min(4, Math.max(0.2, State.view.scale * zoomFactor));
            // Keep the point under the cursor stationary while zooming.
            State.view.x = cssPoint.x - worldBefore.x * State.view.scale;
            State.view.y = cssPoint.y - worldBefore.y * State.view.scale;
            Draw();
        }, { passive: false });

        El.canvas.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const cssPoint = CssPoint(event);
            const hitNodeId = Find_Node_At(cssPoint);
            if (hitNodeId) {
                Show_Node_Panel(hitNodeId, event.clientX, event.clientY);
            } else {
                Hide_Node_Panel();
            }
        });

        document.addEventListener("click", (event) => {
            if (!El.nodePanel.hidden && !El.nodePanel.contains(event.target) && event.target !== El.canvas) {
                Hide_Node_Panel();
            }
        });
    }

    // Mirrors Build_Node_Info_Popup in Node_Info_Popup.py: title row (title +
    // its own Preview Calibrant button + close "x"), a divider, a scrollable
    // key/value grid (EoS/Order/Composition/Max Pressure only), then an
    // actions row with the two chain-focus buttons.
    function Show_Node_Panel(nodeId, clientX, clientY) {
        const node = State.lookup.get(nodeId);
        if (!node) return;

        El.nodePanel.innerHTML = "";

        const titleRow = document.createElement("div");
        titleRow.className = "eosholo-node-panel-title-row";

        let titleText = node.study || node.label;
        if (node.is_special && node.special_type === "not_specified") {
            titleText += " (Not Specified)";
        } else if (node.is_special && node.special_type === "absolute") {
            titleText += " (Absolute)";
        }
        const heading = document.createElement("span");
        heading.className = "eosholo-node-panel-title";
        heading.textContent = titleText;
        titleRow.appendChild(heading);

        const previewButton = document.createElement("button");
        previewButton.className = "eosholo-node-panel-preview-button";
        previewButton.textContent = "Preview Calibrant";
        if (node.info) {
            previewButton.addEventListener("click", () => {
                Open_Calibrant_Preview(node);
                Hide_Node_Panel();
            });
        } else {
            previewButton.disabled = true;
            previewButton.title = "No calibration details are available for this node.";
        }
        titleRow.appendChild(previewButton);

        const closeButton = document.createElement("button");
        closeButton.className = "eosholo-node-panel-close-button";
        closeButton.textContent = "×";
        closeButton.setAttribute("aria-label", "Close");
        closeButton.addEventListener("click", Hide_Node_Panel);
        titleRow.appendChild(closeButton);

        El.nodePanel.appendChild(titleRow);

        const divider = document.createElement("div");
        divider.className = "eosholo-node-panel-divider";
        El.nodePanel.appendChild(divider);

        const fields = document.createElement("div");
        fields.className = "eosholo-node-panel-fields";
        const addField = (label, value) => {
            const dt = document.createElement("span");
            dt.className = "eosholo-node-panel-key";
            dt.textContent = label;
            const dd = document.createElement("span");
            dd.className = "eosholo-node-panel-value";
            dd.textContent = value === null || value === undefined ? "" : String(value);
            fields.appendChild(dt);
            fields.appendChild(dd);
        };
        addField("EoS:", node.eos);
        addField("Order:", node.order);
        addField("Composition:", node.composition);
        addField("Max Pressure:", node.max_pressure);
        El.nodePanel.appendChild(fields);

        if (node.has_calibration) {
            const actions = document.createElement("div");
            actions.className = "eosholo-node-panel-actions";

            const chainToButton = document.createElement("button");
            chainToButton.className = "eosholo-node-panel-action-button";
            chainToButton.textContent = "Calibrant Origin Chain";
            chainToButton.addEventListener("click", () => Focus_To_Node(nodeId));
            actions.appendChild(chainToButton);

            const chainsThroughButton = document.createElement("button");
            chainsThroughButton.className = "eosholo-node-panel-action-button";
            chainsThroughButton.textContent = "Complete Calibrant Chain";
            chainsThroughButton.addEventListener("click", () => Focus_Through_Node(nodeId));
            actions.appendChild(chainsThroughButton);

            El.nodePanel.appendChild(actions);
        }

        const containerRect = El.graphContainer.getBoundingClientRect();
        El.nodePanel.style.left = `${Math.max(0, clientX - containerRect.left)}px`;
        El.nodePanel.style.top = `${Math.max(0, clientY - containerRect.top)}px`;
        El.nodePanel.hidden = false;
    }

    function Hide_Node_Panel() {
        El.nodePanel.hidden = true;
    }
})();
