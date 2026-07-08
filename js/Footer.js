document.addEventListener("DOMContentLoaded", () => {
    // Load the footer partial into the page's #site-footer-mount placeholder
    fetch("/Partials/Footer.html")
        .then((response) => response.text())
        .then((html) => {
            document.getElementById("site-footer-mount").outerHTML = html;
        })
        .catch((error) => console.error("Error loading footer:", error));
});
