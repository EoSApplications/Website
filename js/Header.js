document.addEventListener("DOMContentLoaded", () => {
    // Load the header partial into the page's #site-header-mount placeholder
    fetch("/Partials/Header.html")
        .then((response) => response.text())
        .then((html) => {
            document.getElementById("site-header-mount").outerHTML = html;

            const menuToggleButton = document.getElementById("menu-toggle");
            const menu = document.getElementById("site-menu");
            const header = document.getElementById("site-header");
            const menuItems = menu.querySelectorAll("li a");

            // Position the dropdown directly under the hamburger icon, not
            // wherever it happens to fall in the header's static flow.
            // Right-aligned to the button (rather than left-aligned) so it
            // can't overflow past the viewport's right edge near the toggle.
            const setMenuPosition = () => {
                const buttonRect = menuToggleButton.getBoundingClientRect();
                const headerRect = header.getBoundingClientRect();
                menu.style.right = `${headerRect.right - buttonRect.right}px`;
                menu.style.top = `${buttonRect.bottom - headerRect.top}px`;
            };
            setMenuPosition();
            window.addEventListener("resize", setMenuPosition);

            // Toggle the collapsible menu open/closed
            menuToggleButton.addEventListener("click", (event) => {
                event.stopPropagation();
                setMenuPosition();
                const isVisible = menu.classList.toggle("visible");
                menuToggleButton.setAttribute("aria-expanded", String(isVisible));
            });

            // Close the menu after a link is clicked
            menuItems.forEach((item) => {
                item.addEventListener("click", () => {
                    menu.classList.remove("visible");
                    menuToggleButton.setAttribute("aria-expanded", "false");
                });
            });

            // Close the menu when clicking outside of it
            document.addEventListener("click", (event) => {
                if (!menu.contains(event.target) && event.target !== menuToggleButton) {
                    menu.classList.remove("visible");
                    menuToggleButton.setAttribute("aria-expanded", "false");
                }
            });

            // Light/dark mode toggle
            const themeToggleButton = document.getElementById("theme-toggle");
            const storedTheme = localStorage.getItem("theme");
            const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
            const initialTheme = storedTheme || (prefersDark ? "dark" : "light");
            document.documentElement.setAttribute("data-theme", initialTheme);

            themeToggleButton.addEventListener("click", () => {
                const currentTheme = document.documentElement.getAttribute("data-theme");
                const nextTheme = currentTheme === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-theme", nextTheme);
                localStorage.setItem("theme", nextTheme);
            });
        })
        .catch((error) => console.error("Error loading header:", error));
});
