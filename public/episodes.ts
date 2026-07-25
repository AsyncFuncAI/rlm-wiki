type Episode = {
  title: string;
  shortTitle: string;
  copy: string;
  number: string;
  meta: string;
  video: string;
  poster: string;
};

const episodes: Episode[] = [
  {
    title: "What's rlm-wiki?",
    shortTitle: "What's rlm-wiki?",
    copy: "A short product film for the desktop loop: source-grounded repository context, local CLI agents, and model access that stays with you.",
    number: "Episode 01",
    meta: "10 sec / Desktop film",
    video: "/episodes/rlm-wiki-ep1.mp4",
    poster: "/episodes/rlm-wiki-ep1-poster.jpg",
  },
  {
    title: "The Hot Key (⌘ ⇧ ␣)",
    shortTitle: "The Hot Key",
    copy: "Jump from work to repository context without changing your agent, provider, or credentials.",
    number: "Episode 02",
    meta: "15 sec / Desktop gesture",
    video: "/episodes/rlm-wiki-ep2.mp4",
    poster: "/episodes/rlm-wiki-ep2-poster.jpg",
  },
  {
    title: "Agent Context",
    shortTitle: "Agent Context",
    copy: "Point local agents at source-backed wikis and keep the evidence close to the work.",
    number: "Episode 03",
    meta: "15 sec / Agent handoff",
    video: "/episodes/rlm-wiki-ep3.mp4",
    poster: "/episodes/rlm-wiki-ep3-poster.jpg",
  },
  {
    title: "The Midnight Push",
    shortTitle: "Midnight Push",
    copy: "A late-night release pass where repository memory, public wiki handoff, and local agents stay in the same working rhythm.",
    number: "Episode 04",
    meta: "15 sec / Shipping room",
    video: "/episodes/rlm-wiki-ep4.mp4",
    poster: "/episodes/rlm-wiki-ep4-poster.jpg",
  },
  {
    title: "The Language Mix-Up",
    shortTitle: "Language Mix-Up",
    copy: "A funny localization cut for Japanese and Mandarin support, keeping generated repository context readable across the team.",
    number: "Episode 05",
    meta: "15 sec / Language bit",
    video: "/episodes/rlm-wiki-ep5.mp4",
    poster: "/episodes/rlm-wiki-ep5-poster.jpg",
  },
  {
    title: "Jealousy-Driven Development",
    shortTitle: "Jealousy-Driven Dev",
    copy: "A promotion-party wound becomes a late-night Ask session: research multiple repositories at once and turn rlm-wiki into a source-backed study partner for the next hard thing.",
    number: "Episode 06",
    meta: "15 sec / Ask feature",
    video: "/episodes/rlm-wiki-ep6.mp4",
    poster: "/episodes/rlm-wiki-ep6-poster.jpg",
  },
];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const featureVideo = document.querySelector<HTMLVideoElement>("[data-feature-video]");
const titleNode = document.querySelector<HTMLElement>("[data-episode-title]");
const copyNode = document.querySelector<HTMLElement>("[data-episode-copy]");
const numberNode = document.querySelector<HTMLElement>("[data-episode-number]");
const shortNode = document.querySelector<HTMLElement>("[data-episode-short]");
const metaNode = document.querySelector<HTMLElement>("[data-episode-meta]");
const playButton = document.querySelector<HTMLButtonElement>("[data-play-feature]");
const soundToggle = document.querySelector<HTMLButtonElement>("[data-feature-sound-toggle]");
const previousButton = document.querySelector<HTMLButtonElement>("[data-previous-episode]");
const nextButton = document.querySelector<HTMLButtonElement>("[data-next-episode]");
const cards = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-episode-card]"));

let activeIndex = 0;
let featureSoundEnabled = false;

function syncEpisode(nextIndex: number, shouldPlay: boolean): void {
  const normalizedIndex = (nextIndex + episodes.length) % episodes.length;
  const episode = episodes[normalizedIndex];
  activeIndex = normalizedIndex;

  if (titleNode) titleNode.textContent = episode.title;
  if (copyNode) copyNode.textContent = episode.copy;
  if (numberNode) numberNode.textContent = episode.number;
  if (shortNode) shortNode.textContent = episode.shortTitle;
  if (metaNode) metaNode.textContent = episode.meta;

  if (featureVideo) {
    const currentPath = new URL(featureVideo.currentSrc || featureVideo.src, window.location.href).pathname;
    if (currentPath !== episode.video) {
      featureVideo.poster = episode.poster;
      featureVideo.src = episode.video;
      featureVideo.load();
    }
    featureVideo.muted = !featureSoundEnabled;
    featureVideo.controls = featureSoundEnabled;
    if (shouldPlay && !reducedMotion) void featureVideo.play().catch(() => undefined);
  }

  syncFeatureSoundControls();

  for (const card of cards) {
    const cardIndex = Number(card.dataset.episodeCard || "0");
    const isActive = cardIndex === normalizedIndex;
    card.classList.toggle("active", isActive);
    card.setAttribute("aria-selected", String(isActive));
  }
}

function setFeatureSound(enabled: boolean): void {
  featureSoundEnabled = enabled;
  if (featureVideo) {
    featureVideo.muted = !enabled;
    featureVideo.controls = enabled;
    if (enabled) void featureVideo.play().catch(() => undefined);
  }
  syncFeatureSoundControls();
}

function playFeatureWithSound(): void {
  setFeatureSound(true);
}

function toggleFeatureSound(): void {
  const shouldEnable = !featureSoundEnabled || Boolean(featureVideo?.muted);
  setFeatureSound(shouldEnable);
}

function syncFeatureSoundControls(): void {
  const soundOn = featureSoundEnabled && !featureVideo?.muted;
  if (playButton) playButton.textContent = soundOn ? "Sound on" : "Play with sound";
  if (!soundToggle) return;
  const label = soundOn ? "Mute sound" : "Play with sound";
  soundToggle.classList.toggle("sound-on", soundOn);
  soundToggle.setAttribute("aria-label", label);
  soundToggle.setAttribute("title", label);
}

function bindCardPreview(card: HTMLButtonElement): void {
  const index = Number(card.dataset.episodeCard || "0");
  const episode = episodes[index] || episodes[0];
  const preview = card.querySelector<HTMLVideoElement>("video");
  if (preview) {
    preview.poster = episode.poster;
    preview.src = episode.video;
  }
  card.addEventListener("click", () => syncEpisode(index, true));

  if (!preview || reducedMotion) return;

  card.addEventListener("mouseenter", () => {
    preview.currentTime = 0;
    void preview.play().catch(() => undefined);
  });
  card.addEventListener("mouseleave", () => {
    preview.pause();
    preview.currentTime = 0;
  });
  card.addEventListener("focus", () => {
    void preview.play().catch(() => undefined);
  });
  card.addEventListener("blur", () => {
    preview.pause();
    preview.currentTime = 0;
  });
}

for (const card of cards) bindCardPreview(card);

playButton?.addEventListener("click", playFeatureWithSound);
soundToggle?.addEventListener("click", toggleFeatureSound);
previousButton?.addEventListener("click", () => syncEpisode(activeIndex - 1, true));
nextButton?.addEventListener("click", () => syncEpisode(activeIndex + 1, true));

featureVideo?.addEventListener("pause", () => {
  if (playButton && !featureVideo.ended) {
    playButton.textContent = featureSoundEnabled ? "Resume with sound" : "Play with sound";
  }
});

featureVideo?.addEventListener("play", () => {
  if (featureSoundEnabled) syncFeatureSoundControls();
});

featureVideo?.addEventListener("volumechange", () => {
  featureSoundEnabled = !featureVideo.muted;
  syncFeatureSoundControls();
});

syncEpisode(0, true);
