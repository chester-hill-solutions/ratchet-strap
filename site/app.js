  for (const b of document.querySelectorAll(".copy")) {
    b.addEventListener("click", async () => {
      const target = b.dataset.copyTarget;
      const text = target
        ? document.querySelector(target).textContent.trim()
        : b.dataset.copy;
      const label = b.textContent;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
        document.getElementById("copy-status").textContent = label + " copied";
      } catch {
        b.textContent = "Select it";
      }
      setTimeout(() => (b.textContent = label), 1600);
    });
  }
