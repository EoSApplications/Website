/**
 * Boots a Pyodide runtime, writes Website_Files/Pyodide_Packages/* into its virtual
 * filesystem (using the manifest written by Build/Sync_Pyodide_Packages.py),
 * installs the pure-Python packages those files need (pyyaml, numpy), and
 * returns the ready `pyodide` instance.
 *
 * Pages call this once, then run whatever Python they need against the
 * mounted files (e.g. EoS_Math.Build_Dataframe.Build_Dataframe()).
 */

const PYODIDE_CDN_BASE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PYODIDE_PACKAGES_BASE = "/Pyodide_Packages/";
const MOUNT_ROOT = "/eos_app";

let PyodideReadyPromise = null;

function Load_Script(Source_Url) {
    return new Promise((resolve, reject) => {
        const Script_Tag = document.createElement("script");
        Script_Tag.src = Source_Url;
        Script_Tag.onload = resolve;
        Script_Tag.onerror = () => reject(new Error(`Failed to load ${Source_Url}`));
        document.head.appendChild(Script_Tag);
    });
}

async function Mount_Pyodide_Packages(Pyodide_Instance, Manifest_File_Name = "manifest.json") {
    const Manifest_Response = await fetch(`${PYODIDE_PACKAGES_BASE}${Manifest_File_Name}`);
    const Relative_Paths = await Manifest_Response.json();

    Pyodide_Instance.FS.mkdirTree(MOUNT_ROOT);

    const Fetch_One = async (Relative_Path) => {
        // Encode each path segment (filenames like "Akahama and Kawamura
        // 2004.yaml" contain spaces) without escaping the "/" separators.
        const Encoded_Path = Relative_Path.split("/").map(encodeURIComponent).join("/");
        const File_Response = await fetch(`${PYODIDE_PACKAGES_BASE}${Encoded_Path}`);
        const File_Bytes = new Uint8Array(await File_Response.arrayBuffer());

        const Absolute_Path = `${MOUNT_ROOT}/${Relative_Path}`;
        const Directory_Path = Absolute_Path.split("/").slice(0, -1).join("/");
        Pyodide_Instance.FS.mkdirTree(Directory_Path);
        Pyodide_Instance.FS.writeFile(Absolute_Path, File_Bytes);
    };

    // The browser caps concurrent connections per origin, so Promise.all here
    // is naturally throttled rather than firing dozens of requests at once.
    await Promise.all(Relative_Paths.map(Fetch_One));
}

// Reads Assets/data/Calibration_Files_Source.json (written at build time by
// Generate_Calibration_Files_Source_Config.py) to find the pinned jsDelivr CDN URL
// for the live public Calibration_Files repo. Returns null if that file is missing
// or has no Base_URL -- e.g. the build ran offline and couldn't reach GitHub -- so
// the caller can fall back to the locally-bundled copy.
async function Find_Calibration_Files_Remote_Bundle_Url() {
    try {
        const Source_Response = await fetch("/data/Calibration_Files_Source.json");
        if (!Source_Response.ok) {
            return null;
        }
        const Source_Config = await Source_Response.json();
        return Source_Config.Base_URL ? `${Source_Config.Base_URL}Calibration_Files_Bundle.json` : null;
    } catch (Error) {
        return null;
    }
}

// Fetches Calibration_Files_Bundle.json -- preferring a live fetch from the public
// Calibration_Files repo (pinned to a specific commit via jsDelivr, so the app always
// picks up new/changed calibration files without needing a new website deploy),
// falling back to the copy built and bundled with this site (by Generate_Calibration_Bundle.py
// and Sync_Pyodide_Packages.py) if the live fetch isn't configured or fails -- then writes
// each {file_name: file_text} entry back out as an individual file inside Pyodide's virtual
// filesystem. Load_Calibration_Files.py still sees a plain folder of individual .yaml files,
// exactly as it does on the desktop app, so no Python changes were needed. This replaces
// what used to be 418 separate HTTP requests, one per calibration file.
async function Mount_Calibration_Files_Bundle(Pyodide_Instance) {
    const Local_Bundle_Url = `${PYODIDE_PACKAGES_BASE}Calibration_Files_Bundle.json`;
    const Remote_Bundle_Url = await Find_Calibration_Files_Remote_Bundle_Url();

    let Calibration_File_Contents_By_Name;
    try {
        if (!Remote_Bundle_Url) {
            throw new Error("No live Calibration_Files source configured for this build");
        }
        const Remote_Response = await fetch(Remote_Bundle_Url);
        if (!Remote_Response.ok) {
            throw new Error(`Live calibration bundle fetch failed (${Remote_Response.status})`);
        }
        Calibration_File_Contents_By_Name = await Remote_Response.json();
    } catch (Error) {
        const Local_Response = await fetch(Local_Bundle_Url);
        Calibration_File_Contents_By_Name = await Local_Response.json();
    }

    const Calibration_Files_Root = `${MOUNT_ROOT}/Calibration_Files`;
    Pyodide_Instance.FS.mkdirTree(Calibration_Files_Root);

    for (const [File_Name, File_Text] of Object.entries(Calibration_File_Contents_By_Name)) {
        Pyodide_Instance.FS.writeFile(`${Calibration_Files_Root}/${File_Name}`, File_Text);
    }
}

async function Boot_Pyodide(On_Status) {
    const Report = (Message) => {
        if (On_Status) {
            On_Status(Message);
        }
    };

    Report("Loading Python runtime…");
    if (typeof loadPyodide === "undefined") {
        await Load_Script(`${PYODIDE_CDN_BASE}pyodide.js`);
    }

    const Pyodide_Instance = await loadPyodide({ indexURL: PYODIDE_CDN_BASE });

    Report("Installing packages…");
    // numpy/pyyaml: EoS_Math.Build_Dataframe (calibration loading/parsing). scipy:
    // EoS_Math.Error_Propagation_Functions (root_scalar/brentq). pandas:
    // EoS_Math.Build_Dataframe's own dataframe construction. All are imported
    // transitively just by importing EoS_Math.Build_Dataframe, so all are needed
    // up front on every page that boots Pyodide.
    // matplotlib is NOT loaded here even though Plots/Web_Figure_Generation.py and
    // every Plot_*.py figure module need it -- only Plot_Preview.html ever imports
    // those, so it calls Load_Matplotlib() itself, right before it needs it, instead
    // of paying matplotlib's download/import cost on every EoSAlign.html page load.
    await Pyodide_Instance.loadPackage(["numpy", "pyyaml", "pandas", "scipy"]);

    Report("Loading calibration data…");
    await Promise.all([
        Mount_Pyodide_Packages(Pyodide_Instance),
        Mount_Calibration_Files_Bundle(Pyodide_Instance),
    ]);
    Pyodide_Instance.runPython(`
import sys
if "${MOUNT_ROOT}" not in sys.path:
    sys.path.insert(0, "${MOUNT_ROOT}")
# The figure scripts in Plots/ import each other with flat names
# (e.g. "import Plot_Styling") rather than "Plots.Plot_Styling" — mirrors
# the desktop app's Generate_Figures.Local__Ensure_Paths(), which inserts
# the Plots/ directory itself onto sys.path for the same reason.
_plots_dir = "${MOUNT_ROOT}/Plots"
if _plots_dir not in sys.path:
    sys.path.insert(0, _plots_dir)
`);

    return Pyodide_Instance;
}

/** Returns a shared, lazily-created Pyodide instance (boots once per page). */
function Get_Pyodide(On_Status) {
    if (!PyodideReadyPromise) {
        PyodideReadyPromise = Boot_Pyodide(On_Status);
    }
    return PyodideReadyPromise;
}

let MatplotlibReadyPromise = null;

/** Loads matplotlib into an already-booted Pyodide instance, once per page --
 * only Plot_Preview.html needs this, right before it imports
 * Web_Figure_Generation/Plot_*.py, so it isn't part of Boot_Pyodide() above. */
function Load_Matplotlib(Pyodide_Instance) {
    if (!MatplotlibReadyPromise) {
        MatplotlibReadyPromise = Pyodide_Instance.loadPackage("matplotlib");
    }
    return MatplotlibReadyPromise;
}

let PlotsFilesReadyPromise = null;

/** Mounts Plots/*.py (Web_Figure_Generation.py and every Plot_*.py figure module)
 * into an already-booted Pyodide instance, once per page -- only Plot_Preview.html
 * needs these, so they live in their own manifest_plots.json rather than the core
 * manifest.json every Pyodide page fetches (see Boot_Pyodide() above). */
function Load_Plots_Files(Pyodide_Instance) {
    if (!PlotsFilesReadyPromise) {
        PlotsFilesReadyPromise = Mount_Pyodide_Packages(Pyodide_Instance, "manifest_plots.json");
    }
    return PlotsFilesReadyPromise;
}
