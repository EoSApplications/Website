document.addEventListener("DOMContentLoaded", () => {
    // The calibrations table is generated from Documentation/README.md by
    // Website_Files/Build/Generate_Calibrations_Table.py, so the About page's list
    // stays in sync with the README instead of being hand-transcribed.
    const Mount = document.getElementById("calibrations-table-mount");
    if (!Mount) return;

    fetch("/data/Calibrations_Table.html")
        .then((response) => response.text())
        .then((html) => { Mount.innerHTML = html; })
        .catch((error) => {
            console.error("Error loading calibrations table:", error);
            Mount.innerHTML = "<p>Could not load the calibrations table.</p>";
        });
});
