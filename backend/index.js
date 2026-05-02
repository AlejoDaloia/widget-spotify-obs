import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_KEY
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let access_token = null;
let refresh_token = null;
let cachedNowPlaying = { playing: false };

let isPolling = false;

// LOGIN
app.get("/login", (req, res) => {
  const scope = "user-read-currently-playing";

  const url =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      scope,
      redirect_uri: REDIRECT_URI
    });

  res.redirect(url);
});

// CALLBACK
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    access_token = tokenRes.data.access_token;
    refresh_token = tokenRes.data.refresh_token;

    await supabase.from("spotify_tokens").upsert({
      id: 1,
      access_token,
      refresh_token,
      expires_at: Date.now() + tokenRes.data.expires_in * 1000
    });

    res.send("Autenticado ✔️");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Error auth");
  }
});

// REFRESH
async function refreshAccessToken() {
  try {
    const res = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    access_token = res.data.access_token;

    if (res.data.refresh_token) {
      refresh_token = res.data.refresh_token;
    }

    await supabase
      .from("spotify_tokens")
      .update({
        access_token,
        refresh_token,
        updated_at: new Date()
      })
      .eq("id", 1);

  } catch (err) {
    console.error("Refresh error:", err.response?.data || err.message);
  }
}

// POLLING
async function pollNowPlaying() {
  if (!access_token || isPolling) return;
  isPolling = true;

  try {
    const res = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: { Authorization: `Bearer ${access_token}` }
      }
    );

    if (!res.data || !res.data.item) {
      cachedNowPlaying = { playing: false };
      isPolling = false;
      return;
    } else {
      const track = res.data.item;

      cachedNowPlaying = {
        playing: res.data.is_playing,
        title: track.name,
        artist: track.artists.map(a => a.name).join(", "),
        image: track.album.images?.[0]?.url,
        progress: res.data.progress_ms,
        duration: track.duration_ms
      };
    }
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken();
    }
  }

  isPolling = false;
}

// ENDPOINT
app.get("/now-playing", (req, res) => {
  res.json(cachedNowPlaying);
});

// INIT
async function start() {
  const { data, error } = await supabase
    .from("spotify_tokens")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("Error fetching Spotify tokens:", error);
  } else if (data) {
    access_token = data.access_token;
    refresh_token = data.refresh_token;
  }

  setInterval(pollNowPlaying, 2000);

  app.listen(PORT, () => {
    console.log(`Running on ${PORT}`);
  });
}

start();