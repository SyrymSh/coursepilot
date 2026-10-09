(() => {
  const names = ['Analytical thinking', 'Collaboration', 'Malware prevention', 'Communication', 'Understanding programming languages', 'Using SIEM tools'];
  const counts = { intro: 0, labels: 0, acknowledgements: 0, internalNext: 0, finish: 0 };
  const app = document.getElementById('app');
  const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="25" height="25"%3E%3Crect width="25" height="25" fill="%237aa45c"/%3E%3C/svg%3E';
  let step = -1;
  let complete = false;
  let listener;
  const viewed = new Set();
  const report = () => parent.postMessage({ type: 'fixture:counts', counts }, location.origin);
  function render() {
    if (step < 0) {
      app.innerHTML = `<h2>Explore: Keep organizations secure</h2><p>Explore how entry-level security analysts use a range of skills to help keep organizations secure.</p><img alt="Welcome image" src='${image}'><p><button id="intro" type="button">Continue</button></p>`;
      document.getElementById('intro').onclick = () => { counts.intro += 1; step = 0; render(); report(); };
    } else if (complete) {
      app.innerHTML = `<section id="plugin-container-success"><h2>You’re done!</h2><img alt="Complete image" src='${image}'></section><button id="start-over-button" type="button">Start over</button>`;
      document.getElementById('start-over-button').onclick = () => { counts.finish += 100; report(); };
    } else {
      const done = viewed.has(step);
      app.innerHTML = `<h2>Learn to keep organizations secure</h2><div class="hotspot-map__page${step}"><button id="label" type="button" ${done ? '' : `aria-label="${names[step]}"`}><img alt="step ${done ? 'complete' : 'incomplete'}" src='${image}'></button><p>${names[step]}</p><nav><span class="linear-navigation_count__fixture">${step + 1} of 6</span><button id="internal-next" type="button" ${!done || step === 5 ? 'hidden' : ''}>Next</button></nav></div><button id="finish" type="button" ${step !== 5 || viewed.size !== 6 ? 'hidden' : ''}>Continue</button>`;
      document.getElementById('label').onclick = () => {
        counts.labels += 1; document.getElementById('dialog-title').textContent = names[step];
        document.getElementById('dialog').hidden = false; app.setAttribute('aria-hidden', 'true'); report();
      };
      document.getElementById('internal-next').onclick = () => { counts.internalNext += 1; step += 1; render(); report(); };
      document.getElementById('finish').onclick = () => { counts.finish += 1; complete = true; render(); report(); };
    }
  }
  document.getElementById('ack').onclick = () => {
    counts.acknowledgements += 1; viewed.add(step); document.getElementById('dialog').hidden = true;
    app.removeAttribute('aria-hidden'); render(); report();
  };
  window.chrome = { runtime: { id: 'local-widget-fixture', onMessage: { addListener(value) { listener = value; } } } };
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'fixture:drive') return;
    listener?.({ type: 'WIDGET_CONTINUE', enabled: event.data.enabled }, { id: chrome.runtime.id }, (response) => {
      parent.postMessage({ type: 'fixture:reply', id: event.data.id, response }, location.origin);
    });
  });
  render(); report();
})();
