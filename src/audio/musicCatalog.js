/**
 * In-game soundtrack catalog (public/game music). Titles, artist, album,
 * genre and cover come from each file's ID3 tags; covers were extracted to
 * small JPEGs in public/game music/covers (the embedded art is 0.8–1.5 MB
 * per file). Durations are measured, used for the list before a track loads.
 */

const BASE = `${import.meta.env.BASE_URL}game music/`;

const url = (name) => encodeURI(`${BASE}${name}`);

const cover = (id) => ({
  large: url(`covers/imela-${id}-512.jpg`),
  small: url(`covers/imela-${id}-128.jpg`),
});

const ARTIST = "Amárá-Æon";
const ALBUM = "Imela";

const TRACKS = [
  { title: "Agbani's Interlude", file: "Amárá-Æon - Agbani's Interlude .mp3", cover: "a", genre: "Jazz", duration: 228.1 },
  { title: "Check The Promise", feat: "Acal", file: "Amárá-Æon - Check The Promise ft Acal.mp3", cover: "c", genre: null, duration: 222.9 },
  { title: "Closing Prayer", file: "Amárá-Æon - Closing Prayer.mp3", cover: "b", genre: null, duration: 70.5 },
  { title: "Gaba n'iru", file: "Amárá-Æon - Gaba n'iru.mp3", cover: "a", genre: "Jazz", duration: 125.8 },
  { title: "Gozie Anyi", version: "RDX", file: "Amárá-Æon - Gozie Anyi RDX.mp3", cover: "a", genre: "Jazz", duration: 212.9 },
  { title: "Gozie Anyi", version: "aca", file: "Amárá-Æon - Gozie Anyi aca.mp3", cover: "a", genre: "Jazz", duration: 195.4 },
  { title: "I Chetara Nna", version: "RDX", file: "Amárá-Æon - I Chetara Nna RDX.mp3", cover: "a", genre: "Jazz", duration: 139.1 },
  { title: "Jigide M", file: "Amárá-Æon - Jigide M.mp3", cover: "b", genre: "Jazz", duration: 300.9 },
  { title: "Midway", file: "Amárá-Æon - Midway.mp3", cover: "b", genre: null, duration: 100 },
  { title: "N'Ebe Nzuzo Gị", file: "Amárá-Æon - N'Ebe Nzuzo Gị.mp3", cover: "c", genre: "Jazz", duration: 222.5 },
  { title: "Ndewo Maaria", file: "Amárá-Æon - Ndewo Maaria.mp3", cover: "a", genre: "Jazz", duration: 217.3 },
  { title: "Ntukwasi Obi", file: "Amárá-Æon - Ntukwasi Obi.mp3", cover: "b", genre: "Jazz", duration: 250.9 },
  { title: "Onye Nwetara Amara Ya", file: "Amárá-Æon - Onye Nwetara Amara Ya.mp3", cover: "a", genre: "Jazz", duration: 171.2 },
  { title: "Zọrọ m", file: "Amárá-Æon - Zọrọ m.mp3", cover: "a", genre: "Jazz", duration: 277.7 },
];

function slug(value) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export const MUSIC_CATALOG = TRACKS.map((track) => ({
  id: slug(`${track.title} ${track.version ?? ""}`),
  title: track.title,
  version: track.version ?? null,
  artist: track.feat ? `${ARTIST} ft. ${track.feat}` : ARTIST,
  album: ALBUM,
  genre: track.genre,
  duration: track.duration,
  src: url(track.file),
  cover: cover(track.cover),
}));

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "Gozie Anyi (RDX)" */
export function trackLabel(track) {
  return track.version ? `${track.title} (${track.version})` : track.title;
}
