/**
 * Builds a custom dropdown on top of `rootEl` (an empty <div>): a button
 * showing the current value plus an absolutely-positioned, fully-CSS'd
 * option list. A real <select>'s open popup can't have its hover colors
 * restyled or its option text word-wrapped in most browsers — which is
 * exactly why the desktop app uses a custom WordWrapDelegate for its
 * dropdowns — so this mirrors that instead of fighting native <select>
 * styling limits. Shared by the EoSHolo and EoSAlign pages.
 *
 * `rootEl` keeps acting like a form control everywhere it's used: `.value`
 * is a real getter/setter, and `rootEl.dispatchEvent(new Event("change"))`
 * fires through `addEventListener("change", ...)` exactly like a native
 * element, since rootEl IS the DOM node.
 */
function Make_Dropdown_Widget(rootEl, placeholderText) {
    rootEl.classList.add("app-dropdown", "is-placeholder");
    rootEl.innerHTML = `
        <button type="button" class="app-dropdown-button" aria-haspopup="listbox" aria-expanded="false">
            <span class="app-dropdown-button-text"></span>
        </button>
        <ul class="app-dropdown-list" role="listbox" hidden></ul>
    `;
    const button = rootEl.querySelector(".app-dropdown-button");
    const buttonText = rootEl.querySelector(".app-dropdown-button-text");
    const list = rootEl.querySelector(".app-dropdown-list");

    let currentValue = "";
    let optionsByValue = new Map();
    buttonText.textContent = placeholderText;

    const closeList = () => {
        list.hidden = true;
        button.setAttribute("aria-expanded", "false");
    };
    const openList = () => {
        if (button.disabled) return;
        list.hidden = false;
        button.setAttribute("aria-expanded", "true");
    };

    button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (list.hidden) openList(); else closeList();
    });
    document.addEventListener("click", (event) => {
        if (!rootEl.contains(event.target)) closeList();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeList();
    });

    Object.defineProperty(rootEl, "value", {
        configurable: true,
        get() {
            return currentValue;
        },
        set(newValue) {
            currentValue = newValue || "";
            const option = optionsByValue.get(currentValue);
            buttonText.textContent = option ? option.label : placeholderText;
            rootEl.classList.toggle("is-placeholder", !option);
            for (const li of list.querySelectorAll("li")) {
                li.setAttribute("aria-selected", String(li.dataset.value === currentValue));
            }
        },
    });

    Object.defineProperty(rootEl, "disabled", {
        configurable: true,
        get() {
            return button.disabled;
        },
        set(value) {
            button.disabled = Boolean(value);
            if (button.disabled) closeList();
        },
    });

    rootEl.setOptions = (options) => {
        optionsByValue = new Map(options.map((opt) => [opt.value, opt]));
        list.innerHTML = "";
        for (const opt of options) {
            const li = document.createElement("li");
            li.textContent = opt.label;
            li.dataset.value = opt.value;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", "false");
            li.addEventListener("click", (event) => {
                event.stopPropagation();
                rootEl.value = opt.value;
                closeList();
                rootEl.dispatchEvent(new Event("change"));
            });
            list.appendChild(li);
        }
        if (!optionsByValue.has(currentValue)) {
            rootEl.value = "";
        }
    };

    rootEl.setPlaceholder = (text) => {
        placeholderText = text;
        if (!optionsByValue.has(currentValue)) {
            buttonText.textContent = text;
        }
    };

    return rootEl;
}
