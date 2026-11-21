export function mountPlayerPanel({ onSelect, onOpen, onClose }) {
  const trigger = document.getElementById('player-trigger');
  const dialog = document.getElementById('player-dialog');
  const title = document.getElementById('player-title');
  const form = document.getElementById('player-form');
  const nameInput = document.getElementById('player-name');
  const profileList = document.getElementById('player-profiles');
  const note = document.getElementById('player-note');
  const formError = document.getElementById('player-error');
  const record = document.getElementById('player-record');
  const best = document.getElementById('player-best');
  const rankingStatus = document.getElementById('player-ranking-status');
  const rankingList = document.getElementById('player-ranking-list');
  const rankingBody = rankingList.querySelector('tbody');
  const dismiss = document.getElementById('player-dismiss');
  let player = null;
  let startedOutside = false;

  function setFormError(message) {
    formError.hidden = !message;
    formError.textContent = message;
    if (message) nameInput.setAttribute('aria-invalid', 'true');
    else nameInput.removeAttribute('aria-invalid');
    nameInput.setAttribute('aria-describedby', message ? 'player-note player-error' : 'player-note');
  }

  function open() {
    if (dialog.open) return;
    nameInput.value = player?.name ?? '';
    startedOutside = false;
    setFormError('');
    dialog.showModal();
    dialog.scrollTop = 0;
    trigger.setAttribute('aria-expanded', 'true');
    title.focus({ preventScroll: true });
    onOpen?.();
  }

  function outsideDialog(event) {
    if (event.target !== dialog) return false;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
  }

  function render({ player: nextPlayer, entries, shared, loading, error, profiles = [] }) {
    player = nextPlayer;
    trigger.firstElementChild.textContent = player?.name ?? 'Игрок';
    trigger.setAttribute('aria-label', player ? `Игрок ${player.name}. Открыть рейтинг` : 'Игрок и рейтинг');
    dismiss.textContent = player ? 'К игре' : 'Играть без имени';
    record.hidden = !player;
    best.textContent = player?.best ?? '—';
    note.textContent = shared ? 'Придумай псевдоним. После игры он может появиться в общем рейтинге.' : 'Можно указать псевдоним.';

    const options = profiles.map(({ name }) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    });
    profileList.replaceChildren(...options);

    let status = '';
    if (error) status = 'Общий рейтинг недоступен. Здесь результаты с этого устройства.';
    else if (loading) status = 'Загружаем общий рейтинг…';
    else if (!entries.length) status = 'Здесь появятся результаты после первой игры.';
    else if (!shared) status = 'Результаты с этого устройства.';
    if (rankingStatus.textContent !== status) rankingStatus.textContent = status;

    const rows = entries.map(({ rank, name, best, active }) => {
      const row = document.createElement('tr');
      if (active) row.setAttribute('aria-current', 'true');
      const position = row.insertCell();
      position.textContent = rank;
      const label = row.insertCell();
      const nameText = document.createElement('bdi');
      nameText.textContent = name;
      label.append(nameText);
      const score = row.insertCell();
      score.textContent = best;
      return row;
    });
    rankingBody.replaceChildren(...rows);
    rankingList.hidden = !rows.length;
  }

  trigger.addEventListener('click', open);
  for (const button of [dismiss, document.getElementById('player-close')]) {
    button.addEventListener('click', () => dialog.close());
  }
  dialog.addEventListener('pointerdown', event => { startedOutside = outsideDialog(event); });
  dialog.addEventListener('click', event => {
    if (startedOutside && outsideDialog(event)) dialog.close();
    startedOutside = false;
  });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    trigger.setAttribute('aria-expanded', 'false');
    if (document.activeElement === document.body) trigger.focus({ preventScroll: true });
    onClose?.();
  });
  nameInput.addEventListener('input', () => {
    if (!formError.hidden) setFormError('');
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      setFormError('Введи имя или псевдоним.');
      nameInput.focus();
      return;
    }
    try {
      onSelect(name);
    } catch (error) {
      setFormError(error?.message || 'Не удалось выбрать имя.');
      nameInput.focus();
      return;
    }
    dialog.close();
  });

  return { open, render };
}
