/**
 * EoSAlign — web port of EoSAlign__Step_By_Step_Layout.py's accordion flow.
 *
 * Architecture: EoS_Math.Build_Dataframe's Calibration_List / Build_Dataframe()
 * run live in the browser via Pyodide (unlike EoSHolo's precomputed graph —
 * here the dataframe depends on the visitor's own entered data, so it can't
 * be precomputed at publish time). Reference data (compositions, methods,
 * calibration metadata) is fetched once at boot; Build_Dataframe() is
 * called fresh each time the user reaches Final Actions.
 *
 * Path 1 (non-pressure), Path 2a (pressure, same composition/method), and
 * Path 2b/2c (pressure, via a different composition/method bridge study —
 * mirrors Select_Pressure_Calibration_Study.py's "Use a Pressure Calibration
 * Study with a Different Composition and Method" workflow) are all wired,
 * including real dataframe computation and CSV preview/download in a new
 * tab. matplotlib plot generation (Plot Results) is still deferred to a
 * follow-up pass.
 */

(() => {
    const SECTION_ORDER = [
        "enter-data", "select-composition", "select-method",
        "pressure-calibration", "select-studies", "final-actions",
    ];

    const State = {
        pyodide: null,
        reference: null,        // { compositions, methodUnits, unitToMethod, volumeUnits, compositionsForMethod, methodsForComposition, materialDisplayNames, calibrations }
        data: null,              // Enter Data result (Python-style keys)
        composition: null,
        method: null,
        pressureCalibrationStudy: null, // {"Workflow Type", "Selected Pressure Calibration Study"} or null
        selectedStudies: null,   // [{ "Study Label", "Calibration Key", "Study Metadata" }]
        dataFrame: null,         // { columns: [...], rows: [[...]] } -- desktop-style display headers, for CSV preview
        exportDataFrame: null,   // { columns: [...], rows: [[...]] } -- desktop-style CSV export headers
        rawDataFrame: null,      // { columns: [...], rows: [[...]] } -- raw Pressure_<Calibration_Key> columns, for Plot_Preview.js
        solvedPressuresDataFrame: null, // { columns: [...], rows: [[...]] } or null when Units === "Pressure (GPa)"
    };

    const El = {};

    document.addEventListener("DOMContentLoaded", () => {
        Cache_Elements();
        Boot().catch((error) => {
            console.error("EoSAlign failed to start:", error);
            const detail = (error && (error.message || String(error))) || "Unknown error";
            El.loadingMessage.textContent = `Failed to load EoSAlign: ${detail}`;
        });
    });

    function Cache_Elements() {
        El.loading = document.getElementById("eosalign-loading");
        El.loadingMessage = document.getElementById("eosalign-loading-message");
        El.sections = document.getElementById("eosalign-sections");

        El.manualEntryButton = document.getElementById("manual-entry-button");
        El.uploadFileButton = document.getElementById("upload-file-button");
        El.enterDataBody = document.getElementById("enter-data-body");
        El.manualEntryTextbox = document.getElementById("manual-entry-textbox");
        El.uploadFileRow = document.getElementById("upload-file-row");
        El.uploadFilePath = document.getElementById("upload-file-path");
        El.uploadFileInput = document.getElementById("upload-file-input");
        El.uploadFileBrowseButton = document.getElementById("upload-file-browse-button");
        El.filePreviewTextbox = document.getElementById("file-preview-textbox");
        El.unitsDropdown = Make_Dropdown_Widget(document.getElementById("units-dropdown"), "Select units...");
        El.volumeUnitsRow = document.getElementById("volume-units-row");
        El.volumeUnitsDropdown = Make_Dropdown_Widget(document.getElementById("volume-units-dropdown"), "Select volume units...");
        El.errorPropagationCheckbox = document.getElementById("error-propagation-checkbox");
        El.enterUncertaintyBody = document.getElementById("enter-uncertainty-body");
        El.uncertaintyManualTextbox = document.getElementById("uncertainty-manual-textbox");
        El.uncertaintyUploadRow = document.getElementById("uncertainty-upload-row");
        El.uncertaintyUploadFilePath = document.getElementById("uncertainty-upload-file-path");
        El.uncertaintyUploadFileInput = document.getElementById("uncertainty-upload-file-input");
        El.uncertaintyUploadBrowseButton = document.getElementById("uncertainty-upload-browse-button");
        El.uncertaintyFilePreviewTextbox = document.getElementById("uncertainty-file-preview-textbox");
        El.enterDataContinueButton = document.getElementById("enter-data-continue-button");

        El.compositionDropdown = Make_Dropdown_Widget(document.getElementById("composition-dropdown"), "Select a composition...");
        El.compositionContinueButton = document.getElementById("composition-continue-button");

        El.methodDropdown = Make_Dropdown_Widget(document.getElementById("method-dropdown"), "Select a method...");
        El.methodContinueButton = document.getElementById("method-continue-button");

        El.pressureCalibrationDropdown = Make_Dropdown_Widget(document.getElementById("pressure-calibration-dropdown"), "Select a pressure calibration study...");
        El.pressureCalibrationPreviewButton = document.getElementById("pressure-calibration-preview-button");
        El.useOriginalButton = document.getElementById("use-original-button");
        El.useDifferentButton = document.getElementById("use-different-button");
        El.differentWorkflowContainer = document.getElementById("pressure-calibration-different-workflow");

        El.selectAllStudiesButton = document.getElementById("select-all-studies-button");
        El.deselectAllStudiesButton = document.getElementById("deselect-all-studies-button");
        El.studiesCheckboxList = document.getElementById("studies-checkbox-list");
        El.studiesContinueButton = document.getElementById("studies-continue-button");

        El.customReferenceButton = document.getElementById("custom-reference-button");
        El.customReferenceContainer = document.getElementById("custom-reference-container");
        El.customReferenceInfo = document.getElementById("custom-reference-info");
        El.customReferenceValueLabel = document.getElementById("custom-reference-value-label");
        El.customReferenceValueInput = document.getElementById("custom-reference-value-input");
        El.customReferenceUncLabel = document.getElementById("custom-reference-unc-label");
        El.customReferenceUncInput = document.getElementById("custom-reference-unc-input");

        El.finalActionsStatus = document.getElementById("final-actions-status");
        El.plotResultsButton = document.getElementById("plot-results-button");
        El.previewCsvButton = document.getElementById("preview-csv-button");
        El.exportResultsButton = document.getElementById("export-results-button");
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    async function Boot() {
        const Pyodide_Instance = await Get_Pyodide((message) => {
            El.loadingMessage.textContent = message;
        });
        State.pyodide = Pyodide_Instance;

        El.loadingMessage.textContent = "Loading calibration data…";
        const Result_Json = await Pyodide_Instance.runPythonAsync(`
import json
from EoS_Math.Build_Dataframe import (
    Set_Calibration_File_Settings, All_Compositions, Calibration_List, Calibration_Metadata,
    Get_Compositions_For_Method, Get_Methods_For_Composition,
)
from Reference_Values_And_Units import Method_Units, Volume_Units, Material_Information

# Canonical-only data, same as the EoSHolo build step — never expose a
# visitor's own locally-installed user-edited/entered calibrations.
Set_Calibration_File_Settings(False, False)

_methods = sorted(Method_Units.keys())
_compositions_for_method = {m: Get_Compositions_For_Method(m) for m in _methods}
_methods_for_composition = {c: Get_Methods_For_Composition(c) for c in All_Compositions}
_material_display_names = {c: Material_Information.get(c, {}).get("Display_Name", c) for c in All_Compositions}

_calibrations = []
for _label, _ in Calibration_List:
    _m = Calibration_Metadata[_label]
    _calibrations.append({
        "key": _label,
        "study": _m.get("Study", ""),
        "composition": _m.get("Composition", ""),
        "method": _m.get("Method", ""),
        "eos": _m.get("Equation of State", ""),
        "is_k0_fixed": _m.get("Is The Initial Bulk Modulus Fixed?"),
        "cal_to_name": _m.get("Reference Study", ""),
        "max_pressure": _m.get("Maximum Pressure"),
        "ptm": _m.get("Pressure Transmitting Medium", ""),
        "is_user_edited": bool(_m.get("is_user_edited", False)),
        "is_user_entered": bool(_m.get("is_user_entered", False)),
    })

json.dumps({
    "compositions": All_Compositions,
    "method_units": Method_Units,
    "volume_units": Volume_Units,
    "compositions_for_method": _compositions_for_method,
    "methods_for_composition": _methods_for_composition,
    "material_display_names": _material_display_names,
    "calibrations": _calibrations,
})
`);
        const Raw = JSON.parse(Result_Json);
        State.reference = {
            compositions: Raw.compositions,
            methodUnits: Raw.method_units,
            unitToMethod: Object.fromEntries(Object.entries(Raw.method_units).map(([m, u]) => [u, m])),
            volumeUnits: Raw.volume_units,
            compositionsForMethod: Raw.compositions_for_method,
            methodsForComposition: Raw.methods_for_composition,
            materialDisplayNames: Raw.material_display_names,
            calibrations: Raw.calibrations,
        };

        Wire_Enter_Data();
        Wire_Select_Composition();
        Wire_Select_Method();
        Wire_Pressure_Calibration_Study();
        Wire_Select_Studies_For_Comparison();
        Wire_Final_Actions();
        Wire_Collapsible_Headers();

        Populate_Units_Dropdown();

        El.loading.hidden = true;
        El.sections.hidden = false;
        Expand_Section("enter-data", true);
    }

    // ── Collapsible section helpers (mirrors Collapsible_Content_Container) ──

    function Wire_Collapsible_Headers() {
        for (const header of document.querySelectorAll(".collapsible-header[data-toggle]")) {
            header.addEventListener("click", () => {
                const section = header.closest(".collapsible-section");
                section.classList.toggle("expanded");
            });
        }
    }

    function Get_Section(stepName) {
        return document.querySelector(`.collapsible-section[data-step="${stepName}"]`);
    }

    function Expand_Section(stepName, expand) {
        Get_Section(stepName).classList.toggle("expanded", expand);
    }

    function Show_Section(stepName) {
        Get_Section(stepName).hidden = false;
    }

    function Set_Section_Title(stepName, text) {
        Get_Section(stepName).querySelector(".collapsible-title").textContent = text;
    }

    // Mirrors Hide_Upcoming_Sections: hides this section and everything after it.
    function Hide_Upcoming_Sections(fromStepName) {
        const fromIndex = SECTION_ORDER.indexOf(fromStepName);
        for (let i = fromIndex; i < SECTION_ORDER.length; i++) {
            Get_Section(SECTION_ORDER[i]).hidden = true;
        }
    }

    function Scroll_To_Section(stepName) {
        setTimeout(() => {
            Get_Section(stepName).scrollIntoView({ behavior: "smooth", block: "start" });
        }, 50);
    }

    // ── Text parsing (mirrors Enter_Data.Get_Data_From_Text) ────────────────

    function Get_Data_From_Text(text) {
        if (!text) return [];
        let cleaned = text;
        for (const ch of [",", ";", "\t", "\n"]) cleaned = cleaned.split(ch).join(" ");
        const values = [];
        for (const token of cleaned.split(/\s+/)) {
            if (!token.trim()) continue;
            const value = Number(token);
            if (Number.isFinite(value)) values.push(value);
        }
        return values;
    }

    // ── Step 1: Enter Data (mirrors Enter_Data.py) ──────────────────────────

    function Wire_Enter_Data() {
        let currentMode = null;
        let errorPropagationMode = null;

        const showBody = () => { El.enterDataBody.hidden = false; };

        El.manualEntryButton.addEventListener("click", () => {
            currentMode = "Manual Entry";
            errorPropagationMode = "Manual Entry";
            El.manualEntryButton.classList.add("is-active");
            El.uploadFileButton.classList.remove("is-active");
            showBody();
            El.manualEntryTextbox.hidden = false;
            El.uploadFileRow.hidden = true;
            El.filePreviewTextbox.hidden = true;
            if (El.errorPropagationCheckbox.checked) {
                El.uncertaintyManualTextbox.hidden = false;
                El.uncertaintyUploadRow.hidden = true;
                El.uncertaintyFilePreviewTextbox.hidden = true;
            }
        });

        El.uploadFileButton.addEventListener("click", () => {
            currentMode = "Upload File";
            errorPropagationMode = "Upload File";
            El.uploadFileButton.classList.add("is-active");
            El.manualEntryButton.classList.remove("is-active");
            showBody();
            El.manualEntryTextbox.hidden = true;
            El.uploadFileRow.hidden = false;
            if (El.errorPropagationCheckbox.checked) {
                El.uncertaintyUploadRow.hidden = false;
                El.uncertaintyManualTextbox.hidden = true;
                El.uncertaintyFilePreviewTextbox.hidden = true;
            }
        });

        El.uploadFileBrowseButton.addEventListener("click", () => El.uploadFileInput.click());
        El.uploadFileInput.addEventListener("change", () => {
            const file = El.uploadFileInput.files[0];
            if (file) Read_Uploaded_File(file, El.uploadFilePath, El.filePreviewTextbox);
        });
        Wire_Drag_And_Drop(El.uploadFileRow, El.uploadFilePath, El.filePreviewTextbox);

        El.uncertaintyUploadBrowseButton.addEventListener("click", () => El.uncertaintyUploadFileInput.click());
        El.uncertaintyUploadFileInput.addEventListener("change", () => {
            const file = El.uncertaintyUploadFileInput.files[0];
            if (file) Read_Uploaded_File(file, El.uncertaintyUploadFilePath, El.uncertaintyFilePreviewTextbox);
        });
        Wire_Drag_And_Drop(El.uncertaintyUploadRow, El.uncertaintyUploadFilePath, El.uncertaintyFilePreviewTextbox);

        El.unitsDropdown.addEventListener("change", () => {
            const units = El.unitsDropdown.value;
            const isVolume = units && units.includes("Volume");
            El.volumeUnitsRow.hidden = !isVolume;
            if (isVolume) Populate_Volume_Units_Dropdown();
        });

        El.errorPropagationCheckbox.addEventListener("change", () => {
            const checked = El.errorPropagationCheckbox.checked;
            El.enterUncertaintyBody.hidden = !checked;
            if (checked && currentMode === "Manual Entry") {
                errorPropagationMode = "Manual Entry";
                El.uncertaintyManualTextbox.hidden = false;
                El.uncertaintyUploadRow.hidden = true;
                El.uncertaintyFilePreviewTextbox.hidden = true;
            } else if (checked && currentMode === "Upload File") {
                errorPropagationMode = "Upload File";
                El.uncertaintyUploadRow.hidden = false;
                El.uncertaintyManualTextbox.hidden = true;
                El.uncertaintyFilePreviewTextbox.hidden = true;
            }
        });

        El.enterDataContinueButton.addEventListener("click", () => {
            const Result = Validate_Enter_Data(currentMode, errorPropagationMode);
            if (!Result.ok) {
                alert(Result.message);
                return;
            }
            Continue_From_Enter_Data(Result.data);
        });
    }

    function Wire_Drag_And_Drop(rowEl, pathInputEl, previewEl) {
        rowEl.addEventListener("dragover", (event) => event.preventDefault());
        rowEl.addEventListener("drop", (event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) Read_Uploaded_File(file, pathInputEl, previewEl);
        });
    }

    function Read_Uploaded_File(file, pathInputEl, previewEl) {
        const reader = new FileReader();
        reader.onload = () => {
            pathInputEl.value = file.name;
            previewEl.value = reader.result;
            previewEl.hidden = false;
        };
        reader.readAsText(file);
    }

    function Get_Selected_Units() {
        const text = El.unitsDropdown.value;
        return text || null;
    }

    function Get_Current_Entered_Data(currentMode, errorPropagationMode) {
        const units = Get_Selected_Units();
        const volumeUnit = units && units.includes("Volume") ? (El.volumeUnitsDropdown.value || null) : null;

        let rawData;
        let sourceType;
        if (currentMode === "Upload File") {
            rawData = El.filePreviewTextbox.value.trim();
            sourceType = "Upload File";
        } else {
            rawData = El.manualEntryTextbox.value.trim();
            sourceType = "Manual Entry";
        }
        const dataValues = Get_Data_From_Text(rawData);

        const errorPropagationEnabled = El.errorPropagationCheckbox.checked;
        let uncertaintyData;
        if (!errorPropagationEnabled) {
            uncertaintyData = { "Error Propagation Enabled": false, "Error Propagation Source Type": null, "Error Propagation Values": [] };
        } else if (errorPropagationMode === "Manual Entry") {
            const rawUncertainty = El.uncertaintyManualTextbox.value.trim();
            uncertaintyData = {
                "Error Propagation Enabled": true, "Error Propagation Source Type": "Manual Entry",
                "Error Propagation Values": Get_Data_From_Text(rawUncertainty), "Raw Uncertainty": rawUncertainty,
            };
        } else if (errorPropagationMode === "Upload File") {
            const rawUncertainty = El.uncertaintyFilePreviewTextbox.value.trim();
            uncertaintyData = {
                "Error Propagation Enabled": true, "Error Propagation Source Type": "Upload File",
                "Error Propagation Values": Get_Data_From_Text(rawUncertainty), "Raw Uncertainty": rawUncertainty,
            };
        } else {
            uncertaintyData = { "Error Propagation Enabled": true, "Error Propagation Source Type": null, "Error Propagation Values": [] };
        }

        return {
            "Data": dataValues, "Units": units, "Volume Unit": volumeUnit, "Source Type": sourceType,
            "Raw Data": rawData, "Error Propagation Enabled": errorPropagationEnabled, "Uncertainty Data": uncertaintyData,
        };
    }

    function Validate_Enter_Data(currentMode, errorPropagationMode) {
        if (currentMode === null) return { ok: false, message: "Please select Manual Entry or Upload File." };
        const Data = Get_Current_Entered_Data(currentMode, errorPropagationMode);
        if (!Data["Data"].length) return { ok: false, message: "Please enter at least one data value." };
        if (!Data["Units"]) return { ok: false, message: "Please select units." };
        if (Data["Units"].includes("Volume") && !Data["Volume Unit"]) {
            return { ok: false, message: "Please select volume units." };
        }
        if (Data["Error Propagation Enabled"]) {
            const Unc = Data["Uncertainty Data"]["Error Propagation Values"];
            if (!Unc.length) return { ok: false, message: "Please enter uncertainty values, or disable error propagation." };
            if (Unc.length !== Data["Data"].length) {
                return { ok: false, message: `Entered data length (${Data["Data"].length}) and uncertainty length (${Unc.length}) do not match.` };
            }
        }
        return { ok: true, data: Data };
    }

    function Populate_Units_Dropdown() {
        const units = ["Pressure (GPa)", ...new Set(Object.values(State.reference.methodUnits))].sort((a, b) => {
            if (a === "Pressure (GPa)") return -1;
            if (b === "Pressure (GPa)") return 1;
            return a.localeCompare(b);
        });
        El.unitsDropdown.setOptions(units.map((u) => ({ value: u, label: u })));
    }

    function Populate_Volume_Units_Dropdown() {
        El.volumeUnitsDropdown.setOptions(State.reference.volumeUnits.map((u) => ({ value: u, label: u })));
    }

    // ── Orchestration (mirrors Step_By_Step_Layout_Content's Continue_From_*) ─

    function Find_Auto_Method() {
        if (!State.data || !State.data["Units"]) return null;
        return State.reference.unitToMethod[State.data["Units"]] || null;
    }

    function Continue_From_Enter_Data(Data) {
        State.data = Data;
        const summary = `${Data["Source Type"]}  |  ${Data["Data"].length} values  |  ${Data["Units"]}`;
        Set_Section_Title("enter-data", `Enter Data: ${summary}`);
        Expand_Section("enter-data", false);

        State.composition = null;
        State.method = null;
        State.pressureCalibrationStudy = null;
        State.selectedStudies = null;

        const autoMethod = Find_Auto_Method();
        const allowed = autoMethod ? new Set(State.reference.compositionsForMethod[autoMethod] || []) : null;
        Populate_Composition_Dropdown(allowed);

        Show_Section("select-composition");
        Expand_Section("select-composition", true);
        Set_Section_Title("select-composition", "Select Composition");
        Hide_Upcoming_Sections("select-method");
        Scroll_To_Section("select-composition");
    }

    function Continue_From_Select_Composition(composition) {
        State.composition = composition;
        State.method = null;
        State.pressureCalibrationStudy = null;
        State.selectedStudies = null;
        Set_Section_Title("select-composition", `Composition: ${composition}`);
        Expand_Section("select-composition", false);

        const autoMethod = Find_Auto_Method();
        if (autoMethod) {
            State.method = autoMethod;
            Get_Section("select-method").hidden = true;
            Populate_Studies_For_Comparison();
            Hide_Upcoming_Sections("final-actions");
            Show_Section("select-studies");
            Expand_Section("select-studies", true);
            Set_Section_Title("select-studies", "Select Studies For Comparison");
            Scroll_To_Section("select-studies");
        } else {
            const allowed = new Set(State.reference.methodsForComposition[composition] || []);
            Populate_Method_Dropdown(allowed);
            Show_Section("select-method");
            Expand_Section("select-method", true);
            Set_Section_Title("select-method", "Select Method");
            Hide_Upcoming_Sections("pressure-calibration");
            Scroll_To_Section("select-method");
        }
    }

    function Continue_From_Select_Method(method) {
        State.method = method;
        State.pressureCalibrationStudy = null;
        State.selectedStudies = null;
        Set_Section_Title("select-method", `Method: ${method}`);
        Expand_Section("select-method", false);

        if (State.data["Units"] === "Pressure (GPa)") {
            Populate_Pressure_Calibration_Dropdown();
            Show_Section("pressure-calibration");
            Expand_Section("pressure-calibration", true);
            Set_Section_Title("pressure-calibration", "Select Pressure Calibration Study");
            Hide_Upcoming_Sections("select-studies");
            Scroll_To_Section("pressure-calibration");
        } else {
            State.pressureCalibrationStudy = null;
            Get_Section("pressure-calibration").hidden = true;
            Populate_Studies_For_Comparison();
            Show_Section("select-studies");
            Expand_Section("select-studies", true);
            Set_Section_Title("select-studies", "Select Studies For Comparison");
            Hide_Upcoming_Sections("final-actions");
            Scroll_To_Section("select-studies");
        }
    }

    function Continue_From_Pressure_Calibration_Study(pcs) {
        State.pressureCalibrationStudy = pcs;
        State.selectedStudies = null;

        let summary;
        if (pcs["Workflow Type"] === "Use a Pressure Calibration Study with a Different Composition and Method") {
            summary = `Use a Pressure Calibration Study with a Different Composition and Method: `
                + `Composition: ${pcs["Different Composition"]} Method: ${pcs["Different Method"]}`;
        } else {
            const cal = State.reference.calibrations.find((c) => c.key === pcs["Selected Pressure Calibration Study"]);
            summary = cal ? cal.study : "Unknown";
        }
        Set_Section_Title("pressure-calibration", `Pressure Calibration Study: ${summary}`);
        Expand_Section("pressure-calibration", false);

        Populate_Studies_For_Comparison();
        Show_Section("select-studies");
        Expand_Section("select-studies", true);
        Set_Section_Title("select-studies", "Select Studies For Comparison");
        Hide_Upcoming_Sections("final-actions");
        Scroll_To_Section("select-studies");
    }

    function Continue_From_Select_Studies_For_Comparison(selectedStudies) {
        State.selectedStudies = selectedStudies;
        Set_Section_Title("select-studies", `${selectedStudies.length} studies selected for comparison`);
        Expand_Section("select-studies", false);

        Show_Section("final-actions");
        Expand_Section("final-actions", true);
        Set_Section_Title("final-actions", "Final Actions");
        Scroll_To_Section("final-actions");
        Build_Final_Actions();
    }

    // ── Step 2: Select Composition ───────────────────────────────────────────

    function Wire_Select_Composition() {
        El.compositionContinueButton.addEventListener("click", () => {
            const composition = El.compositionDropdown.value;
            if (!composition) { alert("Please select a composition."); return; }
            Continue_From_Select_Composition(composition);
        });
    }

    function Populate_Composition_Dropdown(allowedSet) {
        const names = State.reference.materialDisplayNames;
        const compositions = (allowedSet ? State.reference.compositions.filter((c) => allowedSet.has(c)) : State.reference.compositions)
            .slice()
            .sort((a, b) => (names[a] || a).localeCompare(names[b] || b));
        El.compositionDropdown.value = "";
        El.compositionDropdown.setOptions(compositions.map((c) => ({ value: c, label: names[c] || c })));
    }

    // ── Step 3: Select Method ────────────────────────────────────────────────

    function Wire_Select_Method() {
        El.methodContinueButton.addEventListener("click", () => {
            const method = El.methodDropdown.value;
            if (!method) { alert("Please select a method."); return; }
            Continue_From_Select_Method(method);
        });
    }

    function Populate_Method_Dropdown(allowedSet) {
        const methods = Object.keys(State.reference.methodUnits).filter((m) => allowedSet.has(m)).sort();
        El.methodDropdown.value = "";
        El.methodDropdown.setOptions(methods.map((m) => ({ value: m, label: m })));
    }

    // ── Step 4: Select Pressure Calibration Study (Path 2a only this pass) ──

    // Mirrors Python's str(None) == "None" — these fields come straight
    // from Calibration_Metadata.get(...) with no default, so a missing
    // value round-trips through JSON as `null`. Interpolating that directly
    // in a JS template literal renders the literal text "null" instead of
    // the "None" the desktop's f-string label shows for the same value.
    function Py_Str(value) {
        return value === null || value === undefined ? "None" : value;
    }

    function Build_Calibration_Label(cal) {
        const prefix = (cal.is_user_edited || cal.is_user_entered) ? "* " : "";
        return `${prefix}${cal.study} | ${cal.composition} | ${cal.method} | ${cal.eos} | `
            + `K0 Fixed: ${Py_Str(cal.is_k0_fixed)} | cal_to: ${Py_Str(cal.cal_to_name)} | `
            + `Max Pressure: ${Py_Str(cal.max_pressure)} GPa | PTM: ${Py_Str(cal.ptm)}`;
    }

    // Tracks the nested .collapsible-section elements created for the
    // "different composition and method" workflow, in order — mirrors
    // Select_Pressure_Calibration_Study.py's
    // Use_A_Pressure_Calibration_Study_With_A_Different_Composition_And_Method_Workflow_Sections.
    let DifferentWorkflowSections = [];
    let SelectedDifferentComposition = null;
    let SelectedDifferentMethod = null;

    function Wire_Pressure_Calibration_Study() {
        El.pressureCalibrationDropdown.addEventListener("change", () => {
            const hasSelection = Boolean(El.pressureCalibrationDropdown.value);
            El.pressureCalibrationPreviewButton.disabled = !hasSelection;
            El.useOriginalButton.disabled = !hasSelection;
            El.useDifferentButton.disabled = !hasSelection;
        });

        El.pressureCalibrationPreviewButton.addEventListener("click", () => {
            const key = El.pressureCalibrationDropdown.value;
            if (key) window.open(`/calibrant-preview/?id=${encodeURIComponent(key)}`, "_blank");
        });

        El.useOriginalButton.addEventListener("click", () => {
            const key = El.pressureCalibrationDropdown.value;
            if (!key) { alert("Please select a pressure calibration study."); return; }
            Clear_Different_Workflow_Sections(0);
            El.useOriginalButton.classList.add("is-active");
            El.useDifferentButton.classList.remove("is-active");
            Continue_From_Pressure_Calibration_Study({
                "Workflow Type": "Use a Pressure Calibration Study with the Original Composition and Method",
                "Selected Pressure Calibration Study": key,
            });
        });

        El.useDifferentButton.addEventListener("click", () => {
            const key = El.pressureCalibrationDropdown.value;
            if (!key) { alert("Please select a pressure calibration study."); return; }
            Clear_Different_Workflow_Sections(0);
            El.useDifferentButton.classList.add("is-active");
            El.useOriginalButton.classList.remove("is-active");
            Show_Select_Different_Composition_Step(key);
        });
    }

    function Populate_Pressure_Calibration_Dropdown() {
        const studies = State.reference.calibrations
            .filter((c) => c.composition === State.composition && c.method === State.method)
            .sort((a, b) => a.study.localeCompare(b.study));
        El.pressureCalibrationDropdown.value = "";
        El.pressureCalibrationDropdown.setOptions(studies.map((c) => ({ value: c.key, label: Build_Calibration_Label(c) })));
        El.pressureCalibrationPreviewButton.disabled = true;
        El.useOriginalButton.disabled = true;
        El.useDifferentButton.disabled = true;
        El.useOriginalButton.classList.remove("is-active");
        El.useDifferentButton.classList.remove("is-active");
        Clear_Different_Workflow_Sections(0);
    }

    // ── Step 4b: "Different Composition and Method" nested workflow
    //    (mirrors Select_Pressure_Calibration_Study.py's
    //    Select_A_Different_Composition / Select_A_Different_Method /
    //    Select_A_Different_Pressure_Calibration_Study) ─────────────────────

    function Create_Nested_Section(title) {
        const section = document.createElement("div");
        section.className = "collapsible-section nested expanded";
        section.innerHTML = `
            <button type="button" class="collapsible-header" data-toggle>
                <span class="collapsible-arrow">&#9654;</span>
                <span class="collapsible-title"></span>
            </button>
            <div class="collapsible-content expanding-content"></div>
        `;
        section.querySelector(".collapsible-title").textContent = title;
        section.querySelector(".collapsible-header").addEventListener("click", () => {
            section.classList.toggle("expanded");
        });
        return section;
    }

    function Add_Different_Workflow_Section(section) {
        El.differentWorkflowContainer.appendChild(section);
        DifferentWorkflowSections.push(section);
        section.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function Clear_Different_Workflow_Sections(keepCount) {
        while (DifferentWorkflowSections.length > keepCount) {
            DifferentWorkflowSections.pop().remove();
        }
        if (keepCount === 0) {
            SelectedDifferentComposition = null;
            SelectedDifferentMethod = null;
        }
    }

    function Show_Select_Different_Composition_Step(firstStudyKey) {
        SelectedDifferentComposition = null;
        SelectedDifferentMethod = null;

        const section = Create_Nested_Section("Select A Different Composition");
        const content = section.querySelector(".collapsible-content");

        const row = document.createElement("div");
        row.className = "eosalign-field-row";
        const label = document.createElement("label");
        label.textContent = "Select Composition:";
        const dropdownEl = document.createElement("div");
        dropdownEl.className = "app-dropdown eosalign-grow";
        row.append(label, dropdownEl);
        content.appendChild(row);

        const continueButton = document.createElement("button");
        continueButton.type = "button";
        continueButton.className = "primary-button full-width-button";
        continueButton.textContent = "Continue";
        content.appendChild(continueButton);

        const dropdown = Make_Dropdown_Widget(dropdownEl, "Select a composition...");
        const names = State.reference.materialDisplayNames;
        const compositions = State.reference.compositions.slice()
            .sort((a, b) => (names[a] || a).localeCompare(names[b] || b));
        dropdown.setOptions(compositions.map((c) => ({ value: c, label: names[c] || c })));

        continueButton.addEventListener("click", () => {
            const composition = dropdown.value;
            if (!composition) { alert("Please select a composition."); return; }
            SelectedDifferentComposition = composition;
            section.querySelector(".collapsible-title").textContent =
                `Composition For The Pressure Calibration Study: ${names[composition] || composition}`;
            section.classList.remove("expanded");
            Clear_Different_Workflow_Sections(1);
            Show_Select_Different_Method_Step(firstStudyKey);
        });

        Add_Different_Workflow_Section(section);
    }

    function Show_Select_Different_Method_Step(firstStudyKey) {
        SelectedDifferentMethod = null;

        const section = Create_Nested_Section("Select A Different Method");
        const content = section.querySelector(".collapsible-content");

        const row = document.createElement("div");
        row.className = "eosalign-field-row";
        const label = document.createElement("label");
        label.textContent = "Select Method:";
        const dropdownEl = document.createElement("div");
        dropdownEl.className = "app-dropdown eosalign-grow";
        row.append(label, dropdownEl);
        content.appendChild(row);

        const continueButton = document.createElement("button");
        continueButton.type = "button";
        continueButton.className = "primary-button full-width-button";
        continueButton.textContent = "Continue";
        content.appendChild(continueButton);

        const dropdown = Make_Dropdown_Widget(dropdownEl, "Select a method...");
        const methods = Object.keys(State.reference.methodUnits).sort();
        dropdown.setOptions(methods.map((m) => ({ value: m, label: m })));

        continueButton.addEventListener("click", () => {
            const method = dropdown.value;
            if (!method) { alert("Please select a method."); return; }
            SelectedDifferentMethod = method;
            section.querySelector(".collapsible-title").textContent = `Method For The Pressure Calibration Study: ${method}`;
            section.classList.remove("expanded");
            Clear_Different_Workflow_Sections(2);
            Show_Select_Different_Pressure_Calibration_Study_Step(firstStudyKey);
        });

        Add_Different_Workflow_Section(section);
    }

    // Mirrors
    // Find_List_Of_All_Studies_With_Compositions_And_Methods_That_Match_The_Original_Selections_And_Pressure_Calibration_Study_Selections:
    // the intersection of study NAMES present in both (compositionA, methodA)
    // and (compositionB, methodB).
    function Find_Matching_Study_Names(compositionA, methodA, compositionB, methodB) {
        const namesA = new Set(State.reference.calibrations
            .filter((c) => c.composition === compositionA && c.method === methodA)
            .map((c) => c.study));
        const namesB = new Set(State.reference.calibrations
            .filter((c) => c.composition === compositionB && c.method === methodB)
            .map((c) => c.study));
        return [...namesA].filter((name) => namesB.has(name));
    }

    function Show_Select_Different_Pressure_Calibration_Study_Step(firstStudyKey) {
        const section = Create_Nested_Section("Select A Pressure Calibration Study");
        const content = section.querySelector(".collapsible-content");
        const originalCal = State.reference.calibrations.find((c) => c.key === firstStudyKey);

        const originalHeader = document.createElement("p");
        originalHeader.className = "eosalign-sub-label";
        originalHeader.textContent = "Study Selected For Pressure Conversion:";
        content.appendChild(originalHeader);

        const originalRow = document.createElement("div");
        originalRow.className = "eosalign-field-row eosalign-indent";
        const originalDropdownEl = document.createElement("div");
        originalDropdownEl.className = "app-dropdown eosalign-grow";
        const originalPreviewButton = document.createElement("button");
        originalPreviewButton.type = "button";
        originalPreviewButton.className = "preview-button";
        originalPreviewButton.textContent = "Preview Calibrant";
        originalPreviewButton.addEventListener("click", () => {
            window.open(`/calibrant-preview/?id=${encodeURIComponent(firstStudyKey)}`, "_blank");
        });
        originalRow.append(originalDropdownEl, originalPreviewButton);
        content.appendChild(originalRow);

        const originalDropdown = Make_Dropdown_Widget(originalDropdownEl, "");
        originalDropdown.setOptions([{ value: originalCal.key, label: Build_Calibration_Label(originalCal) }]);
        originalDropdown.value = originalCal.key;
        originalDropdown.disabled = true;

        const caution = document.createElement("p");
        caution.className = "eosalign-sub-label";
        caution.innerHTML = '<span class="caution-asterisk">*</span> This was the study selected above for the original composition and method.';
        content.appendChild(caution);

        const explanation = document.createElement("p");
        explanation.textContent = `The selected study for ${State.composition}/${State.method} will be set equal to `
            + `the pressure for the selected study with a composition of ${SelectedDifferentComposition} `
            + `and a method of ${SelectedDifferentMethod}.`;
        content.appendChild(explanation);

        const bridgeHeader = document.createElement("p");
        bridgeHeader.className = "eosalign-sub-label";
        bridgeHeader.textContent = "Select A Pressure Calibration Study For Conversion:";
        content.appendChild(bridgeHeader);

        const bridgeRow = document.createElement("div");
        bridgeRow.className = "eosalign-field-row eosalign-indent";
        const bridgeDropdownEl = document.createElement("div");
        bridgeDropdownEl.className = "app-dropdown eosalign-grow";
        const bridgePreviewButton = document.createElement("button");
        bridgePreviewButton.type = "button";
        bridgePreviewButton.className = "preview-button";
        bridgePreviewButton.textContent = "Preview Calibrant";
        bridgePreviewButton.disabled = true;
        bridgeRow.append(bridgeDropdownEl, bridgePreviewButton);
        content.appendChild(bridgeRow);

        const matchingNames = Find_Matching_Study_Names(
            State.composition, State.method, SelectedDifferentComposition, SelectedDifferentMethod,
        );
        const bridgeCandidates = State.reference.calibrations
            .filter((c) => c.composition === State.composition && c.method === State.method
                && matchingNames.includes(c.study) && c.key !== firstStudyKey)
            .sort((a, b) => a.study.localeCompare(b.study));

        const bridgeDropdown = Make_Dropdown_Widget(
            bridgeDropdownEl,
            bridgeCandidates.length
                ? "Select a pressure calibration study..."
                : "No studies available for both compositions and methods",
        );
        bridgeDropdown.setOptions(bridgeCandidates.map((c) => ({ value: c.key, label: Build_Calibration_Label(c) })));
        bridgeDropdown.disabled = !bridgeCandidates.length;

        if (!bridgeCandidates.length) {
            const errorLabel = document.createElement("p");
            errorLabel.style.color = "var(--warning-color)";
            errorLabel.textContent = `No studies found that exist in both ${State.composition}/${State.method} `
                + `and ${SelectedDifferentComposition}/${SelectedDifferentMethod}.`;
            content.appendChild(errorLabel);
        }

        const targetHeader = document.createElement("p");
        targetHeader.className = "eosalign-sub-label";
        targetHeader.textContent = "Select A Pressure Calibration Study For The Different Composition and Method:";
        content.appendChild(targetHeader);

        const targetRow = document.createElement("div");
        targetRow.className = "eosalign-field-row eosalign-indent";
        const targetDropdownEl = document.createElement("div");
        targetDropdownEl.className = "app-dropdown eosalign-grow";
        const targetPreviewButton = document.createElement("button");
        targetPreviewButton.type = "button";
        targetPreviewButton.className = "preview-button";
        targetPreviewButton.textContent = "Preview Calibrant";
        targetPreviewButton.disabled = true;
        targetRow.append(targetDropdownEl, targetPreviewButton);
        content.appendChild(targetRow);

        const targetDropdown = Make_Dropdown_Widget(targetDropdownEl, "First select a study for conversion above...");
        targetDropdown.disabled = true;

        bridgePreviewButton.addEventListener("click", () => {
            if (bridgeDropdown.value) window.open(`/calibrant-preview/?id=${encodeURIComponent(bridgeDropdown.value)}`, "_blank");
        });
        targetPreviewButton.addEventListener("click", () => {
            if (targetDropdown.value) window.open(`/calibrant-preview/?id=${encodeURIComponent(targetDropdown.value)}`, "_blank");
        });

        const Update_Target_Dropdown = (bridgeKey) => {
            targetDropdown.value = "";
            if (!bridgeKey) {
                targetDropdown.setOptions([]);
                targetDropdown.disabled = true;
                targetDropdown.setPlaceholder("First select a study for conversion above...");
                targetPreviewButton.disabled = true;
                return;
            }
            const bridgeStudyName = State.reference.calibrations.find((c) => c.key === bridgeKey).study;
            const targets = State.reference.calibrations
                .filter((c) => c.composition === SelectedDifferentComposition && c.method === SelectedDifferentMethod
                    && c.study === bridgeStudyName)
                .sort((a, b) => a.study.localeCompare(b.study));
            targetDropdown.setOptions(targets.map((c) => ({ value: c.key, label: Build_Calibration_Label(c) })));
            if (targets.length) {
                targetDropdown.disabled = false;
                if (targets.length === 1) targetDropdown.value = targets[0].key;
                targetDropdown.setPlaceholder("Select a pressure calibration study...");
            } else {
                targetDropdown.disabled = true;
                targetDropdown.setPlaceholder("No matching study for the different composition and method");
            }
            targetPreviewButton.disabled = !targetDropdown.value;
        };

        bridgeDropdown.addEventListener("change", () => {
            bridgePreviewButton.disabled = !bridgeDropdown.value;
            Update_Target_Dropdown(bridgeDropdown.value);
        });
        targetDropdown.addEventListener("change", () => {
            targetPreviewButton.disabled = !targetDropdown.value;
        });

        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "primary-button full-width-button";
        confirmButton.textContent = "Confirm Pressure Conversion Selection";
        content.appendChild(confirmButton);

        confirmButton.addEventListener("click", () => {
            if (!bridgeDropdown.value) { alert("Please select a pressure calibration study with a different composition and method."); return; }
            if (!targetDropdown.value) { alert("Please select a final pressure calibration study."); return; }

            const bridgeCal = State.reference.calibrations.find((c) => c.key === bridgeDropdown.value);
            section.querySelector(".collapsible-title").textContent =
                `Pressure Conversion: ${originalCal.study} (${State.composition}, ${State.method}) = `
                + `${bridgeCal.study} (${SelectedDifferentComposition}, ${SelectedDifferentMethod})`;
            section.classList.remove("expanded");

            Continue_From_Pressure_Calibration_Study({
                "Workflow Type": "Use a Pressure Calibration Study with a Different Composition and Method",
                "Selected Pressure Calibration Study": firstStudyKey,
                "Originally Selected Pressure Calibration Study": firstStudyKey,
                "Different Composition": SelectedDifferentComposition,
                "Different Method": SelectedDifferentMethod,
                "Different Pressure Calibration Study": bridgeDropdown.value,
                "Target Pressure Calibration Study": targetDropdown.value,
                "Implementing A Secondary Pressure Conversion": true,
            });
        });

        Add_Different_Workflow_Section(section);
    }

    // ── Step 5: Select Studies For Comparison (mirrors Select_Studies_For_Comparison.py) ──

    // Track the custom-reference state and the method used for the currently
    // rendered comparison-study list so refreshes preserve the desktop state.
    let CustomReferenceEnabled = false;
    let CustomReferenceLabel = "Reference Value";
    let RenderedComparisonMethod = null;

    function Wire_Select_Studies_For_Comparison() {
        El.selectAllStudiesButton.addEventListener("click", () => {
            El.studiesCheckboxList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
        });
        El.deselectAllStudiesButton.addEventListener("click", () => {
            El.studiesCheckboxList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
        });

        El.customReferenceButton.addEventListener("click", () => {
            CustomReferenceEnabled = !CustomReferenceEnabled;
            El.customReferenceContainer.hidden = !CustomReferenceEnabled;
            if (CustomReferenceEnabled) {
                El.customReferenceButton.textContent = `✓ Using Custom ${CustomReferenceLabel}`;
            } else {
                El.customReferenceButton.textContent = `Use Custom ${CustomReferenceLabel}`;
                El.customReferenceValueInput.value = "";
                El.customReferenceUncInput.value = "";
            }
            Apply_Custom_Reference_To_Data();
        });

        // Keep the calculation data synchronized as the user edits either
        // custom-reference field, matching the desktop textChanged signals.
        El.customReferenceValueInput.addEventListener("input", Apply_Custom_Reference_To_Data);
        El.customReferenceUncInput.addEventListener("input", Apply_Custom_Reference_To_Data);

        El.studiesContinueButton.addEventListener("click", () => {
            if (!State.composition || !State.method) {
                window.alert("Missing Composition Or Method Selection");
                return;
            }

            const selected = Get_Selected_Studies_For_Comparison();

            // Match the desktop confirmation before continuing without any
            // comparison studies.
            if (!selected.length && !window.confirm("No studies are selected. Continue without studies?")) {
                return;
            }

            Apply_Custom_Reference_To_Data();
            Continue_From_Select_Studies_For_Comparison(selected);
        });
    }

    // Mirrors Select_Studies_For_Comparison.py's Update_Custom_Ref_Labels:
    // recomputes the reference label/unit from the current method, resets
    // the toggle, and shows the button only for non-pressure units (a
    // pressure-calibration study, not a measured-value reference, is what
    // establishes the pressure scale in the pressure-units workflow).
    function Update_Custom_Reference_Labels(shouldPreserveCustomReference = false) {
        const savedCustomReferenceEnabled = CustomReferenceEnabled;
        const savedCustomReferenceValue = El.customReferenceValueInput.value;
        const savedCustomReferenceUncertainty = El.customReferenceUncInput.value;
        const inputVolumeUnit = (State.data && State.data["Volume Unit"]) || "";
        let refLabel;
        let refUnit;
        if (State.method === "XRD") {
            refLabel = "V₀ (Initial Volume)";
            refUnit = inputVolumeUnit;
        } else if (State.method === "Luminescence") {
            refLabel = "λ₀ (Initial Wavelength)";
            refUnit = "nm";
        } else if (State.method === "Raman") {
            refLabel = "ν₀ (Initial Wavenumber)";
            refUnit = "cm⁻¹";
        } else {
            refLabel = "Reference Value";
            refUnit = "";
        }

        CustomReferenceLabel = refLabel;
        CustomReferenceEnabled = false;
        El.customReferenceContainer.hidden = true;
        El.customReferenceValueInput.value = "";
        El.customReferenceUncInput.value = "";

        El.customReferenceButton.textContent = `Use Custom ${refLabel}`;
        El.customReferenceInfo.textContent = `Override the calibration's ${refLabel} with your own value.\nThis does not modify the YAML files.`;
        El.customReferenceValueLabel.textContent = `${refLabel} (${refUnit}):`;
        El.customReferenceValueInput.placeholder = `Enter ${refLabel}...`;
        El.customReferenceUncLabel.textContent = `Uncertainty (${refUnit}):`;

        El.customReferenceButton.hidden = State.data["Units"] === "Pressure (GPa)";

        if (shouldPreserveCustomReference) {
            CustomReferenceEnabled = savedCustomReferenceEnabled;
            El.customReferenceValueInput.value = savedCustomReferenceValue;
            El.customReferenceUncInput.value = savedCustomReferenceUncertainty;
            El.customReferenceContainer.hidden = !savedCustomReferenceEnabled;
            if (savedCustomReferenceEnabled) {
                El.customReferenceButton.textContent = `✓ Using Custom ${refLabel}`;
            }
        }

        Apply_Custom_Reference_To_Data();
    }

    // Mirrors Select_Studies_For_Comparison.py's Get_Custom_Reference_Value.
    function Get_Custom_Reference_Value() {
        if (!CustomReferenceEnabled) return null;

        const valueText = El.customReferenceValueInput.value.trim();
        if (!valueText) return null;
        const value = Number.parseFloat(valueText);
        if (Number.isNaN(value)) return null;

        let uncertainty = 0;
        const uncText = El.customReferenceUncInput.value.trim();
        if (uncText) {
            const parsedUnc = Number.parseFloat(uncText);
            if (!Number.isNaN(parsedUnc)) uncertainty = parsedUnc;
        }

        let refType;
        if (State.method === "XRD") refType = "V0";
        else if (State.method === "Luminescence") refType = "lambda_0";
        else if (State.method === "Raman") refType = "nu_0";
        else refType = "unknown";

        return { value, uncertainty, type: refType, method: State.method };
    }

    // Store or clear the session-only custom reference immediately so every
    // downstream calculation sees the current UI state.
    function Apply_Custom_Reference_To_Data() {
        if (!State.data) return;

        const customReference = Get_Custom_Reference_Value();
        if (customReference) {
            State.data["custom_reference"] = customReference;
        } else {
            delete State.data["custom_reference"];
        }
    }

    function Get_Selected_Studies_For_Comparison() {
        const result = [];
        El.studiesCheckboxList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            if (!cb.checked) return;

            const calibration = State.reference.calibrations.find((candidate) => candidate.key === cb.dataset.key);
            result.push({
                "Study Label": cb.dataset.label,
                "Calibration Key": cb.dataset.key,
                "Study Metadata": calibration,
            });
        });
        return result;
    }

    function Populate_Studies_For_Comparison() {
        const previousSelections = new Set(
            Array.from(El.studiesCheckboxList.querySelectorAll('input[type="checkbox"]:checked'))
                .map((checkbox) => checkbox.dataset.key)
        );
        const shouldPreserveCustomReference = (
            State.method === RenderedComparisonMethod
            && State.method !== null
            && State.data["Units"] !== "Pressure (GPa)"
        );

        Update_Custom_Reference_Labels(shouldPreserveCustomReference);
        El.studiesCheckboxList.innerHTML = "";

        // Mirrors Select_Studies_For_Comparison.py's Populate_Checkboxes: when
        // converting via a different composition/method, the comparison
        // studies must come from THAT composition/method (since that's what
        // the converted dataset will actually be compared against), excluding
        // both the bridge and target studies used for the conversion itself.
        let comparisonComposition = State.composition;
        let comparisonMethod = State.method;
        const excludeKeys = new Set();
        if (State.pressureCalibrationStudy) {
            const pcs = State.pressureCalibrationStudy;
            if (pcs["Workflow Type"] === "Use a Pressure Calibration Study with a Different Composition and Method") {
                comparisonComposition = pcs["Different Composition"];
                comparisonMethod = pcs["Different Method"];
                excludeKeys.add(pcs["Different Pressure Calibration Study"]);
                excludeKeys.add(pcs["Target Pressure Calibration Study"]);
            } else {
                excludeKeys.add(pcs["Selected Pressure Calibration Study"]);
            }
        }

        const studies = State.reference.calibrations
            .filter((c) => c.composition === comparisonComposition && c.method === comparisonMethod && !excludeKeys.has(c.key))
            .sort((a, b) => a.study.localeCompare(b.study));

        RenderedComparisonMethod = State.method;

        if (!studies.length) {
            const p = document.createElement("p");
            p.textContent = `No studies available for composition ${comparisonComposition} and method ${comparisonMethod}.`;
            El.studiesCheckboxList.appendChild(p);
            return;
        }

        for (const cal of studies) {
            const label = Build_Calibration_Label(cal);
            const row = document.createElement("div");
            row.className = "eosalign-study-row";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = `study-checkbox-${cal.key}`;
            checkbox.dataset.key = cal.key;
            checkbox.dataset.label = label;
            checkbox.checked = previousSelections.has(cal.key);
            row.appendChild(checkbox);

            const labelEl = document.createElement("label");
            labelEl.setAttribute("for", checkbox.id);
            labelEl.textContent = label;
            row.appendChild(labelEl);

            const previewButton = document.createElement("button");
            previewButton.type = "button";
            previewButton.className = "preview-button";
            previewButton.textContent = "Preview Calibrant";
            previewButton.addEventListener("click", (event) => {
                event.preventDefault();
                window.open(`/calibrant-preview/?id=${encodeURIComponent(cal.key)}`, "_blank");
            });
            row.appendChild(previewButton);

            El.studiesCheckboxList.appendChild(row);
        }
    }

    // ── Step 6: Final Actions (mirrors Select_Final_Actions.py) ─────────────

    function Wire_Final_Actions() {
        El.previewCsvButton.addEventListener("click", Preview_Csv);
        El.exportResultsButton.addEventListener("click", Export_Results_Csv);
        El.plotResultsButton.addEventListener("click", Plot_Results);
    }

    // Hands the already-computed dataframe plus the inputs Plot_Preview.js
    // needs to rebuild the figure dataset (mirrors Select_Final_Actions's
    // Start_Figure_Generation, which derives Reference_Key/Original_Study_Key
    // from Pressure_Calibration_Study the same way) over to a new tab.
    function Plot_Results() {
        if (!State.rawDataFrame) return;
        sessionStorage.setItem("eosalign_plot_request", JSON.stringify({
            dataFrame: State.rawDataFrame,
            composition: State.composition,
            method: State.method,
            inputMode: State.data["Units"],
            pressureCalibrationStudy: State.pressureCalibrationStudy,
            selectedKeys: (State.selectedStudies || []).map((s) => s["Calibration Key"]),
        }));
        window.open("/plot-preview/", "_blank");
    }

    // Writes text into Pyodide's virtual filesystem and returns the path,
    // mirroring Enter_Data.Save_Data_To_A_Temporary_File (the desktop app
    // also round-trips entered data through a temp file before
    // Build_Dataframe reads it back with Read_Input_Data_From_A_File).
    function Write_Temp_Data_File(pyodide, text, name) {
        const path = `/tmp/${name}`;
        pyodide.FS.mkdirTree("/tmp");
        pyodide.FS.writeFile(path, text);
        return path;
    }

    async function Build_Final_Actions() {
        El.finalActionsStatus.textContent = "Computing…";
        El.plotResultsButton.disabled = true;
        El.previewCsvButton.disabled = true;
        El.exportResultsButton.disabled = true;

        const Data = Object.assign({}, State.data);
        Data["File_Path"] = Write_Temp_Data_File(State.pyodide, Data["Raw Data"], "eosalign_input.txt");

        const Uncertainty = Object.assign({}, Data["Uncertainty Data"]);
        if (Uncertainty["Error Propagation Enabled"] && Uncertainty["Raw Uncertainty"]) {
            Uncertainty["Error Propagation Path"] = Write_Temp_Data_File(State.pyodide, Uncertainty["Raw Uncertainty"], "eosalign_uncertainty.txt");
        }
        Data["Uncertainty Data"] = Uncertainty;

        const payload = {
            data: Data,
            composition: State.composition,
            method: State.method,
            pressure_calibration_study: State.pressureCalibrationStudy,
            selected_studies: (State.selectedStudies || []).map((s) => s["Calibration Key"]),
        };

        State.pyodide.globals.set("eosalign_request_json", JSON.stringify(payload));
        const Result_Json = await State.pyodide.runPythonAsync(`
import json
from EoS_Math.Build_Dataframe import Build_Dataframe, Translate_Pressure_Calibration_Study, Calibration_Metadata

_req = json.loads(eosalign_request_json)
_data = _req["data"]
_pcs = Translate_Pressure_Calibration_Study(_req.get("pressure_calibration_study"))
_file_ok, _units_ok, _err, _df = Build_Dataframe(
    Data=_data,
    Units=_data.get("Units"),
    Composition=_req["composition"],
    Method=_req["method"],
    Pressure_Calibration_Study=_pcs,
    Selected_Studies_For_Comparison=_req["selected_studies"],
)
if _df is not None and not _df.empty:
    # Rename raw Pressure_<Calibration_Key> columns to the descriptive study/composition/method
    # label the desktop app uses for its CSV export (mirrors Select_Final_Actions.py's
    # Build_Pressure_Column_Rename_Map — kept local to the website build, since that function
    # lives in the desktop-only Select_Final_Actions.py rather than the EoS_Math package that
    # gets synced into the Pyodide bundle)
    _rename_map = {}
    for _col in _df.columns:
        if _col.startswith("Pressure_") and not _col.startswith("Pressure_From_"):
            _cal_name = _col[len("Pressure_"):]
            _meta = Calibration_Metadata.get(_cal_name, {})
            if _meta:
                _study = _meta.get("Study", _cal_name)
                _comp = _meta.get("Composition", "")
                _method = _meta.get("Method", "")
                _eos = _meta.get("Equation of State", "")
                _k0_fixed = _meta.get("Is The Initial Bulk Modulus Fixed?", "")
                _cal_to = _meta.get("Reference Study", "")
                _max_p = _meta.get("Maximum Pressure", "")
                _ptm = _meta.get("Pressure Transmitting Medium", "")
                _rename_map[_col] = f"Pressure_{_study} | {_comp} | {_method} | {_eos} | K0 Fixed: {_k0_fixed} | cal_to: {_cal_to} | Max Pressure: {_max_p} | PTM: {_ptm}"
    _export_df = _df.rename(columns=_rename_map)

    # Build the same human-readable headers shown by the desktop
    # Data_Preview_Dialog.Populate_Table method.
    _preview_columns = []
    for _column_name in _df.columns:
        if _column_name.startswith("Measured_"):
            _preview_columns.append(_column_name.replace("Measured_", "Input: ").replace("_Input", ""))
        elif _column_name.startswith("Input_Pressure_"):
            _preview_columns.append("Input:\\nPressure (GPa)")
        elif "_From_" in _column_name and not _column_name.startswith("Pressure_From_"):
            _unit_label, _study_and_rest = _column_name.split("_From_", 1)
            if "_(" in _study_and_rest:
                _study, _composition_method_raw = _study_and_rest.rsplit("_(", 1)
                _composition_method = _composition_method_raw.rstrip(")").replace("_", " / ")
                _preview_columns.append(f"{_unit_label}\\nFrom {_study}\\n({_composition_method})")
            else:
                _preview_columns.append(f"{_unit_label}\\nFrom {_study_and_rest}")
        elif _column_name.startswith("Pressure_From_") and "(" in _column_name:
            _parts = _column_name.replace("Pressure_From_", "").split("(")
            _study = _parts[0].strip("_")
            _composition_method = _parts[1].rstrip(")").replace("_", " / ")
            _preview_columns.append(f"Pressure\\nFrom {_study}\\n({_composition_method})")
        elif _column_name.startswith("Assumed_Equal_Pressure_"):
            _parts = _column_name.replace("Assumed_Equal_Pressure_", "").split("_=_")
            if len(_parts) == 2:
                _preview_columns.append(f"Assumption:\\n{_parts[0]}\\n= {_parts[1]}\\n(Pressure)")
            else:
                _preview_columns.append(_column_name.replace("_", " "))
        elif _column_name.startswith("Pressure_") and not _column_name.startswith("Pressure_From_"):
            _calibration_name = _column_name[len("Pressure_"):]
            _metadata = Calibration_Metadata.get(_calibration_name, {})
            _study = _metadata.get("Study", _calibration_name)
            _preview_columns.append(f"Output:\\nPressure (GPa)\\n{_study}")
        elif _column_name.startswith("Output: "):
            _label = _column_name[len("Output: "):]
            if _label.endswith("_Unc"):
                _preview_columns.append(f"Output Unc:\\n{_label[:-4]}")
            else:
                _preview_columns.append(f"Output:\\n{_label}")
        elif _column_name == "Volume_A3_UnitCell":
            _preview_columns.append("Volume (Å³/unit cell)\\n(converted; used for calculations)")
        elif _column_name == "Volume_A3_UnitCell_Unc":
            _preview_columns.append("Volume Unc (Å³/unit cell)")
        elif _column_name.startswith("Input_") and not _column_name.startswith("Input_Pressure_"):
            if _column_name.endswith("_Unc"):
                _original_label = _column_name[len("Input_"):-len("_Unc")].replace("_per_", "/").replace("_", " ")
                _preview_columns.append(f"Input Unc (original):\\n{_original_label}")
            else:
                _original_label = _column_name[len("Input_"):].replace("_per_", "/").replace("_", " ")
                _preview_columns.append(f"Input (original):\\n{_original_label}")
        elif " | " in _column_name:
            _preview_columns.append("\\n".join(_column_name.split(" | ")))
        else:
            _preview_columns.append(_column_name.replace("_", " "))

    # Build the solved-pressures subset (measured column plus every renamed pressure column)
    # whenever the input units are not already Pressure (GPa), mirroring
    # Build_Solved_Pressures_Dataframe / the "_solved_pressures.csv" export in the desktop app
    _solved_columns, _solved_rows = [], []
    if _data.get("Units") != "Pressure (GPa)":
        _volume_unit = _data.get("Volume Unit")
        _display_units = _volume_unit if (_volume_unit and "Volume" in str(_data.get("Units"))) else _data.get("Units")
        _measured_col = _export_df.columns[0]
        _pressure_cols = [c for c in _export_df.columns if c.startswith("Pressure_") and " | " in c]
        if _pressure_cols:
            _solved_df = _export_df[[_measured_col] + _pressure_cols].rename(
                columns={_measured_col: f"Input_{_display_units}, STUDIES USED:"})
            _solved_columns = list(_solved_df.columns)
            _solved_rows = _solved_df.astype(object).where(_solved_df.notnull(), None).values.tolist()

    _result = {
        "file_ok": _file_ok,
        "units_ok": _units_ok,
        "error": _err,
        "columns": list(_export_df.columns),
        "preview_columns": _preview_columns,
        "rows": _export_df.astype(object).where(_export_df.notnull(), None).values.tolist(),
        # Raw (un-renamed) Pressure_<Calibration_Key> columns -- Plot_Preview.js hands these
        # straight to Web_Figure_Generation.Build_Dataset_From_App_Data, which looks columns
        # up by the raw calibration key, not the descriptive CSV-export label above.
        "raw_columns": list(_df.columns),
        "raw_rows": _df.astype(object).where(_df.notnull(), None).values.tolist(),
        "solved_columns": _solved_columns,
        "solved_rows": _solved_rows,
    }
else:
    _result = {
        "file_ok": _file_ok, "units_ok": _units_ok, "error": _err,
        "columns": [], "preview_columns": [], "rows": [], "raw_columns": [], "raw_rows": [], "solved_columns": [], "solved_rows": [],
    }
json.dumps(_result)
`);
        const Result = JSON.parse(Result_Json);

        if (!Result.file_ok || !Result.units_ok || !Result.rows.length) {
            State.dataFrame = null;
            State.exportDataFrame = null;
            State.rawDataFrame = null;
            State.solvedPressuresDataFrame = null;
            El.finalActionsStatus.textContent = Result.error || "Could not compute results from the current selections.";
            return;
        }

        State.dataFrame = { columns: Result.preview_columns, rows: Result.rows };
        State.exportDataFrame = { columns: Result.columns, rows: Result.rows };
        State.rawDataFrame = { columns: Result.raw_columns, rows: Result.raw_rows };
        State.solvedPressuresDataFrame = Result.solved_columns.length
            ? { columns: Result.solved_columns, rows: Result.solved_rows }
            : null;
        El.finalActionsStatus.textContent = `Computed ${Result.rows.length} row(s) across ${Result.columns.length} column(s).`;
        El.plotResultsButton.disabled = false;
        El.previewCsvButton.disabled = false;
        El.exportResultsButton.disabled = false;
    }

    function Dataframe_To_Csv(dataFrame) {
        const escapeCell = (value) => {
            if (value === null || value === undefined) return "";
            const text = String(value);
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const lines = [dataFrame.columns.map(escapeCell).join(",")];
        for (const row of dataFrame.rows) lines.push(row.map(escapeCell).join(","));
        return lines.join("\n");
    }

    function Preview_Csv() {
        if (!State.dataFrame) return;
        sessionStorage.setItem("eosalign_dataframe", JSON.stringify(State.dataFrame));
        window.open("/csv-preview/", "_blank");
    }

    function Download_Csv_File(dataFrame, filename) {
        const csv = Dataframe_To_Csv(dataFrame);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    function Export_Results_Csv() {
        if (!State.exportDataFrame) return;
        Download_Csv_File(State.exportDataFrame, "comparison.csv");
        // Mirrors the desktop app's "<name>_solved_pressures.csv" second file, which is
        // written right after the main CSV whenever the input units aren't already Pressure (GPa)
        if (State.solvedPressuresDataFrame) {
            Download_Csv_File(State.solvedPressuresDataFrame, "comparison_solved_pressures.csv");
        }
    }
})();
