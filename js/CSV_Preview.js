/**
 * Renders the dataframe computed by EoSAlign.js's Final Actions step.
 * Data is handed off via sessionStorage (not a URL — a full dataframe is
 * too large for a query string), under the key "eosalign_dataframe".
 */

document.addEventListener("DOMContentLoaded", () => {
    const Raw = sessionStorage.getItem("eosalign_dataframe");
    const Table = document.getElementById("csv-preview-table");
    const DownloadButton = document.getElementById("csv-download-button");

    if (!Raw) {
        Table.outerHTML = "<p>No computed data found. Run EoSAlign and click \"Preview CSV Data\" again.</p>";
        DownloadButton.disabled = true;
        return;
    }

    const DataFrame = JSON.parse(Raw);
    Render_Table(Table, DataFrame);
    DownloadButton.addEventListener("click", () => Download_Csv(DataFrame));
});

function Render_Table(table, dataFrame) {
    const Thead = document.createElement("thead");
    const HeaderRow = document.createElement("tr");
    for (const column of dataFrame.columns) {
        const th = document.createElement("th");
        th.textContent = column;
        HeaderRow.appendChild(th);
    }
    Thead.appendChild(HeaderRow);
    table.appendChild(Thead);

    const Tbody = document.createElement("tbody");
    for (const row of dataFrame.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
            const td = document.createElement("td");
            td.textContent = cell === null || cell === undefined ? "" : String(cell);
            tr.appendChild(td);
        }
        Tbody.appendChild(tr);
    }
    table.appendChild(Tbody);
}

function Escape_Csv_Cell(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function Download_Csv(dataFrame) {
    const lines = [dataFrame.columns.map(Escape_Csv_Cell).join(",")];
    for (const row of dataFrame.rows) lines.push(row.map(Escape_Csv_Cell).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "comparison.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
