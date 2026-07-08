/**
 * Plot_Preview — runs Plots/Web_Figure_Generation.py (the Pyodide-safe port
 * of the desktop app's Generate_Figures.py) against the dataframe EoSAlign.js
 * already computed, then displays each figure with its own light/dark theme
 * + background (transparent/white/black) download options — mirrors the
 * desktop's Plot_Window + Export_Figures_Dialog, scoped down to one
 * theme/background choice per download rather than a batch multi-export.
 *
 * State handoff: EoSAlign.js's "Plot Results" button stores the request
 * (already-computed dataframe + composition/method/pressure-calibration
 * selections) into sessionStorage under "eosalign_plot_request" before
 * opening this page in a new tab.
 */

(() => {
    const FIGURE_TITLES = {
        observable_vs_pressure: "Measured Value vs Pressure",
        all_eos_overlay_absolute_pressure_difference: "Pressure Difference (GPa) - All EoS",
        all_eos_overlay_percent_pressure_difference: "Pressure Difference (%) - All EoS",
        pressure_scale_disagreement: "Pressure Scale Disagreement",
        individual_absolute_pressure_difference: "Individual EoS (Pdiff)",
        individual_percent_pressure_difference: "Individual EoS (Pdiff %)",
        summary_observable_vs_pressure_and_overlay: "Combined Summary",
    };

    const THEME_KEYS = ["Primary_Text", "Secondary_Text", "Primary_Color", "Secondary_Background", "Primary_Background"];
    const BACKGROUND_COLORS = { transparent: "none", white: "#FFFFFF", black: "#000000" };

    const El = {};
    let RenderFigureFn = null;
    let ThemePalettes = null;

    document.addEventListener("DOMContentLoaded", () => {
        El.loading = document.getElementById("plot-preview-loading");
        El.loadingMessage = document.getElementById("plot-preview-loading-message");
        El.figures = document.getElementById("plot-preview-figures");

        Boot().catch((error) => {
            console.error("Plot Preview failed to start:", error);
            const detail = (error && (error.message || String(error))) || "Unknown error";
            El.loading.classList.add("is-error");
            El.loadingMessage.textContent = `Failed to generate plots: ${detail}`;
        });
    });

    function Theme_Overrides_For(themeName) {
        const palette = (ThemePalettes && ThemePalettes[themeName]) || {};
        const overrides = {};
        for (const key of THEME_KEYS) overrides[key] = palette[key];
        return overrides;
    }

    async function Boot() {
        const Request_Json = sessionStorage.getItem("eosalign_plot_request");
        if (!Request_Json) {
            El.loading.classList.add("is-error");
            El.loadingMessage.textContent = "No plot request found. Go back to EoSAlign and click \"Plot Results\" again.";
            return;
        }

        const Theme_Response = await fetch("/Pyodide_Packages/Themes/theme.json");
        ThemePalettes = await Theme_Response.json();

        const Pyodide_Instance = await Get_Pyodide((message) => {
            El.loadingMessage.textContent = message;
        });

        // matplotlib and Plots/*.py aren't part of Boot_Pyodide()'s upfront package/file
        // set (see Pyodide_Bootstrap.js) since only this page ever needs them -- load both
        // now, before importing Web_Figure_Generation below, which needs them directly.
        El.loadingMessage.textContent = "Loading plotting library…";
        await Promise.all([Load_Matplotlib(Pyodide_Instance), Load_Plots_Files(Pyodide_Instance)]);

        El.loadingMessage.textContent = "Building figure dataset…";
        Pyodide_Instance.globals.set("eosalign_plot_request_json", Request_Json);
        const Boot_Result_Json = await Pyodide_Instance.runPythonAsync(`
import json
import math
import importlib
import pandas as pd
from Web_Figure_Generation import Build_Dataset_From_App_Data, Get_Module_Names_For_Input_Mode

_req = json.loads(eosalign_plot_request_json)
_columns = _req["dataFrame"]["columns"]
_rows = [[(math.nan if v is None else v) for v in row] for row in _req["dataFrame"]["rows"]]
_df = pd.DataFrame(_rows, columns=_columns)

_pcs = _req.get("pressureCalibrationStudy")
_composition = _req["composition"]
_method = _req["method"]
_input_mode = _req["inputMode"]
_selected_keys = _req.get("selectedKeys") or []

# Mirrors Select_Final_Actions.Start_Figure_Generation's derivation of the
# reference/original study keys and the dataset's own composition/method
# from Pressure_Calibration_Study (still in its UI-format dict here).
_reference_key = None
_original_study_key = None
_dataset_composition = _composition
_dataset_method = _method
if isinstance(_pcs, dict):
    _original_study_key = _pcs.get("Selected Pressure Calibration Study")
    if _pcs.get("Workflow Type") == "Use a Pressure Calibration Study with a Different Composition and Method":
        _reference_key = _pcs.get("Target Pressure Calibration Study")
        _dataset_composition = _pcs.get("Different Composition") or _composition
        _dataset_method = _pcs.get("Different Method") or _method
    else:
        _reference_key = _pcs.get("Selected Pressure Calibration Study")

_eosalign_plot_dataset = Build_Dataset_From_App_Data(
    _df, _dataset_composition, _dataset_method, _reference_key, _selected_keys, _input_mode, _original_study_key,
)
_module_names = Get_Module_Names_For_Input_Mode(_input_mode)
_module_infos = []
for _name in _module_names:
    _mod = importlib.import_module(_name)
    _module_infos.append({"module_name": _name, "basename": _mod.Figure_Basename})

import base64
def _eosalign_render_figure(module_name, theme_overrides_json, save_transparent, save_face_color):
    from Web_Figure_Generation import AppFigureConfig, Generate_Figure_Png_Bytes
    theme_overrides = json.loads(theme_overrides_json)
    config = AppFigureConfig(
        Show_Bands=True, Show_Error_Bars=False, Show_Grid=False,
        Theme_Overrides=theme_overrides, Ps_Overrides=None,
        Save_Transparent=bool(save_transparent), Save_Face_Color=save_face_color,
    )
    png_bytes = Generate_Figure_Png_Bytes(_eosalign_plot_dataset, module_name, config)
    return base64.b64encode(png_bytes).decode("ascii")

json.dumps({"module_infos": _module_infos})
`);
        const Boot_Result = JSON.parse(Boot_Result_Json);
        RenderFigureFn = Pyodide_Instance.globals.get("_eosalign_render_figure");

        if (!Boot_Result.module_infos.length) {
            El.loading.classList.add("is-error");
            El.loadingMessage.textContent = "No figures are available for the current selections.";
            return;
        }

        El.loading.hidden = true;
        El.figures.hidden = false;

        const siteTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
        for (const info of Boot_Result.module_infos) {
            const card = Build_Figure_Card(info, siteTheme);
            El.figures.appendChild(card);
        }
    }

    async function Render_To_Base64(moduleName, themeName, backgroundName) {
        const themeOverrides = Theme_Overrides_For(themeName);
        const transparent = backgroundName === "transparent";
        const faceColor = transparent ? "none" : BACKGROUND_COLORS[backgroundName];
        if (!transparent) themeOverrides.Primary_Background = faceColor;
        return RenderFigureFn(moduleName, JSON.stringify(themeOverrides), transparent, faceColor);
    }

    function Build_Figure_Card(info, siteTheme) {
        const card = document.createElement("section");
        card.className = "plot-card";

        const title = document.createElement("h2");
        title.className = "plot-card-title";
        title.textContent = FIGURE_TITLES[info.basename] || info.basename;
        card.appendChild(title);

        const imageWrap = document.createElement("div");
        imageWrap.className = "plot-card-image-wrap";
        const image = document.createElement("img");
        image.className = "plot-card-image";
        image.alt = title.textContent;
        imageWrap.appendChild(image);
        card.appendChild(imageWrap);

        const status = document.createElement("p");
        status.className = "plot-card-status";
        status.textContent = "Rendering…";
        card.appendChild(status);

        const controls = document.createElement("div");
        controls.className = "plot-card-controls";
        const themeDropdownEl = document.createElement("div");
        themeDropdownEl.className = "app-dropdown";
        const backgroundDropdownEl = document.createElement("div");
        backgroundDropdownEl.className = "app-dropdown";
        const downloadButton = document.createElement("button");
        downloadButton.type = "button";
        downloadButton.className = "primary-button";
        downloadButton.textContent = "Download PNG";
        downloadButton.disabled = true;
        controls.append(themeDropdownEl, backgroundDropdownEl, downloadButton);
        card.appendChild(controls);

        const themeDropdown = Make_Dropdown_Widget(themeDropdownEl, "Theme...");
        themeDropdown.setOptions([{ value: "light", label: "Light Theme" }, { value: "dark", label: "Dark Theme" }]);
        themeDropdown.value = siteTheme;

        const backgroundDropdown = Make_Dropdown_Widget(backgroundDropdownEl, "Background...");
        backgroundDropdown.setOptions([
            { value: "transparent", label: "Transparent Background" },
            { value: "white", label: "White Background" },
            { value: "black", label: "Black Background" },
        ]);
        backgroundDropdown.value = "transparent";

        downloadButton.addEventListener("click", async () => {
            downloadButton.disabled = true;
            downloadButton.textContent = "Rendering…";
            try {
                const base64 = await Render_To_Base64(info.module_name, themeDropdown.value, backgroundDropdown.value);
                const link = document.createElement("a");
                link.href = `data:image/png;base64,${base64}`;
                link.download = `${info.basename}__${themeDropdown.value}__${backgroundDropdown.value}.png`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } catch (error) {
                console.error(`Failed to render ${info.module_name}:`, error);
                alert(`Failed to render this figure: ${(error && error.message) || error}`);
            } finally {
                downloadButton.disabled = false;
                downloadButton.textContent = "Download PNG";
            }
        });

        // Render the initial display image using the page's own current
        // theme, transparent background — mirrors Generate_Figures.py's
        // "Display_Config" (always transparent, current app theme).
        Render_To_Base64(info.module_name, siteTheme, "transparent")
            .then((base64) => {
                image.src = `data:image/png;base64,${base64}`;
                status.hidden = true;
                downloadButton.disabled = false;
            })
            .catch((error) => {
                console.error(`Failed to render ${info.module_name}:`, error);
                status.textContent = `Failed to render: ${(error && error.message) || error}`;
            });

        return card;
    }
})();
