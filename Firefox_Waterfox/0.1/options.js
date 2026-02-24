var pageMenuCheckbox = document.getElementById("pageMenu");
var saveButton = document.getElementById("save");
var statusSpan = document.getElementById("status");

function showStatus(text) {
  statusSpan.textContent = text;
  if (text) setTimeout(function () { statusSpan.textContent = ""; }, 1200);
}

function loadSettings() {
  browser.storage.sync.get({ pageMenu: false }).then(function (cfg) {
    pageMenuCheckbox.checked = !!cfg.pageMenu;
  });
}

function saveSettings() {
  browser.storage.sync.set({ pageMenu: !!pageMenuCheckbox.checked }).then(function () {
    showStatus("Saved");
  });
}

saveButton.addEventListener("click", saveSettings);
loadSettings();
