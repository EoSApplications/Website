/**
 * Renders the read-only "view mode" calibration preview — reached either via
 * EoSHolo's "Preview Calibrant" buttons (?id=<node_id> already set) or
 * directly from the site menu's "View Calibration" link (no selection yet).
 * Either way, the Composition/Study dropdowns at the top let a visitor
 * browse to any calibration, mirroring
 * View_Edit_And_Save_Calibration_Files_In_A_New_Window.py's Build_Calibration_Selector
 * (view-only here — there's no in-browser editing on the website).
 *
 * Data comes from the same Calibration_Graph.json built by
 * Build_Calibration_Graph.py — each node's `info.sections` (an ordered list,
 * each either a normal {name, rows} section or a {name, type: 'references',
 * references} section for "Pressure Calibration Reference", in the same
 * order/position as Calibration_Field_Sections) is pre-computed there using
 * the desktop app's own field labels/sections/visibility rules (see
 * Build_Calibration_Info in that script), so this file only has to render
 * already-decided content, not re-derive it.
 *
 * Header/Banner/Footer on this page are the same shared partials as every
 * other app page (mounted by Header.js/Banner.js/Footer.js) — theme
 * light/dark handling comes from Header.js, not this file.
 */

document.addEventListener("DOMContentLoaded", async () => {
    const Container = document.getElementById("calibrant-preview");
    const El = {
        compositionDropdown: Make_Dropdown_Widget(
            document.getElementById("cp-composition-dropdown"), "Select a composition..."
        ),
        studyDropdown: Make_Dropdown_Widget(
            document.getElementById("cp-study-dropdown"), "Select a pressure calibration study..."
        ),
    };

    let Graph;
    try {
        const Response = await fetch("/data/Calibration_Graph.json");
        Graph = await Response.json();
    } catch (error) {
        console.error("Could not load calibration data:", error);
        Container.innerHTML = "<p>Could not load calibration data.</p>";
        return;
    }

    Populate_Composition_Dropdown(Graph, El);
    Wire_Controls(Graph, El, Container);

    const NodeId = new URLSearchParams(window.location.search).get("id");
    if (!NodeId) {
        Show_Placeholder(Container);
        return;
    }

    const Node = Graph.nodes.find((n) => n.node_id === NodeId && n.has_calibration && n.info);
    if (!Node) {
        Container.innerHTML = "<p>Calibration not found.</p>";
        return;
    }
    Sync_Dropdowns_To_Node(Graph, El, Node);
    Show_Node(Container, Node);
});

// ── Composition/Study selectors (mirrors EoSHolo.js's dropdown helpers) ────

function Populate_Composition_Dropdown(Graph, El) {
    const Names = Graph.composition_display_names;
    const Sorted = [...Graph.compositions].sort((a, b) =>
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

function Populate_Study_Dropdown(Graph, El, composition, selectLabel) {
    const Labels = [...new Set(
        Graph.nodes
            .filter((n) => n.composition === composition && n.has_calibration)
            .map((n) => n.display_label)
    )].sort(Compare_Study_Keys);
    El.studyDropdown.setOptions(Labels.map((label) => ({ value: label, label })));
    if (selectLabel && Labels.includes(selectLabel)) {
        El.studyDropdown.value = selectLabel;
    }
}

function Get_Selected_Node(Graph, El) {
    const Composition = El.compositionDropdown.value;
    const Label = El.studyDropdown.value;
    if (!Composition || !Label) return null;
    return Graph.nodes.find(
        (n) => n.composition === Composition && n.display_label === Label && n.has_calibration
    ) || null;
}

function Sync_Dropdowns_To_Node(Graph, El, Node) {
    El.compositionDropdown.value = Node.composition;
    Populate_Study_Dropdown(Graph, El, Node.composition, Node.display_label);
}

function Wire_Controls(Graph, El, Container) {
    El.compositionDropdown.addEventListener("change", () => {
        Populate_Study_Dropdown(Graph, El, El.compositionDropdown.value, null);
        Show_Placeholder(Container);
        Update_Url_Id(null);
    });

    El.studyDropdown.addEventListener("change", () => {
        const Node = Get_Selected_Node(Graph, El);
        if (Node && Node.info) {
            Show_Node(Container, Node);
            Update_Url_Id(Node.node_id);
        } else {
            Show_Placeholder(Container);
            Update_Url_Id(null);
        }
    });
}

// Keeps the URL bookmarkable/shareable without a page reload, so the
// dropdown selection and the "Preview Calibrant" deep-link (?id=) stay
// in sync no matter which way this page was reached.
function Update_Url_Id(NodeId) {
    const Url = new URL(window.location.href);
    if (NodeId) {
        Url.searchParams.set("id", NodeId);
    } else {
        Url.searchParams.delete("id");
    }
    window.history.replaceState({}, "", Url);
}

function Show_Placeholder(Container) {
    document.title = "Calibrant Preview";
    Container.innerHTML = "<p>Select a composition and study above to view its calibration details.</p>";
}

function Show_Node(Container, Node) {
    document.title = `${Node.study} — Calibrant Preview`;
    Render_Calibrant_Preview(Container, Node);
}

function Render_Calibrant_Preview(Container, Node) {
    Container.innerHTML = "";

    const Title = document.createElement("h1");
    Title.textContent = Node.study;
    Container.appendChild(Title);

    const Subtitle = document.createElement("p");
    Subtitle.className = "calibrant-preview-subtitle";
    Subtitle.textContent = `${Node.composition} — ${Node.method}`;
    Container.appendChild(Subtitle);

    for (const Section of Node.info.sections) {
        Container.appendChild(
            Section.type === "references"
                ? Render_Reference_Section(Section.name, Section.references)
                : Render_Section(Section.name, Section.rows)
        );
    }
}

function Render_Reference_Section(Name, References) {
    const Details = document.createElement("details");
    Details.open = true;
    Details.className = "calibrant-preview-section";

    const Summary = document.createElement("summary");
    Summary.textContent = Name;
    Details.appendChild(Summary);

    for (const Reference of References) {
        Details.appendChild(Render_Reference_Block(Reference));
    }
    return Details;
}

function Render_Section(Name, Rows) {
    const Details = document.createElement("details");
    Details.open = true;
    Details.className = "calibrant-preview-section";

    const Summary = document.createElement("summary");
    Summary.textContent = Name;
    Details.appendChild(Summary);

    const Grid = document.createElement("div");
    Grid.className = "calibrant-preview-grid";
    for (const Row of Rows) {
        const Key = document.createElement("div");
        Key.className = "calibrant-preview-key";
        Key.innerHTML = Row.label_html;
        Grid.appendChild(Key);

        // Mirrors Unit_Line_Edit: the value box plus a unit label to its
        // right (e.g. "GPa" for Maximum Pressure, "Å³/unit cell" for V0).
        const Cell = document.createElement("div");
        Cell.className = "calibrant-preview-value-cell";
        Cell.appendChild(Render_Value_Cell(Row));
        if (Row.unit) {
            const Unit = document.createElement("span");
            Unit.className = "calibrant-preview-unit";
            Unit.textContent = Row.unit;
            Cell.appendChild(Unit);
        }
        Grid.appendChild(Cell);
    }
    Details.appendChild(Grid);
    return Details;
}

function Render_Value_Cell(Row) {
    const Value = document.createElement("div");
    Value.className = "calibrant-preview-value";

    if (Row.doi_lines) {
        for (const Line of Row.doi_lines) {
            const LineEl = document.createElement("div");
            if (Line.url) {
                const Link = document.createElement("a");
                Link.href = Line.url;
                Link.target = "_blank";
                Link.rel = "noopener";
                Link.textContent = Line.text;
                LineEl.appendChild(Link);
            } else {
                LineEl.textContent = Line.text;
            }
            Value.appendChild(LineEl);
        }
    } else if (Row.is_equation) {
        const Equation = document.createElement("div");
        Equation.className = "calibrant-preview-equation";
        try {
            katex.render(Row.value, Equation, { throwOnError: false, displayMode: true });
        } catch (error) {
            Equation.textContent = Row.value;
        }
        Value.appendChild(Equation);
    } else {
        Value.textContent = Row.value;
    }
    return Value;
}

function Render_Reference_Block(Reference) {
    const Block = document.createElement("div");
    Block.className = "calibrant-preview-reference";

    const Title = document.createElement("h3");
    Title.textContent = Reference.title;
    Block.appendChild(Title);

    const Grid = document.createElement("div");
    Grid.className = "calibrant-preview-grid";
    for (const Field of Reference.fields) {
        const Key = document.createElement("div");
        Key.className = "calibrant-preview-key";
        Key.textContent = `${Field.label}:`;
        Grid.appendChild(Key);

        const Value = document.createElement("div");
        Value.className = "calibrant-preview-value";
        Value.textContent = Field.value;
        Grid.appendChild(Value);
    }
    Block.appendChild(Grid);
    return Block;
}
