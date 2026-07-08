document.addEventListener("DOMContentLoaded", () => {
    // Each page provides a mount point with data attributes describing which
    // app's sun/logo image to show and where "home" for that app is:
    //   <div id="app-banner-mount" data-sun-image="..." data-app-name="..." data-home-href="..."></div>
    const mount = document.getElementById("app-banner-mount");
    if (!mount) {
        return;
    }

    const sunImage = mount.dataset.sunImage;
    const appName = mount.dataset.appName || "Home";
    const homeHref = mount.dataset.homeHref || window.location.pathname;

    document.body.classList.add("has-banner");

    fetch("/Partials/Banner.html")
        .then((response) => response.text())
        .then((html) => {
            mount.outerHTML = html;

            const homeButton = document.getElementById("banner-home-button");
            homeButton.style.backgroundImage = `url('${sunImage}')`;
            homeButton.setAttribute("aria-label", `${appName} home`);
            homeButton.setAttribute("title", `Restart ${appName}`);

            homeButton.addEventListener("click", () => {
                // Clear any in-progress decisions for this session, then return
                // to the start of the application (a fresh load of its page).
                sessionStorage.clear();
                window.location.href = homeHref;
            });
        })
        .catch((error) => console.error("Error loading banner:", error));
});
