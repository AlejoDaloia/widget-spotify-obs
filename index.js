import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import {  fileURLToPath } from 'url';

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

// Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let access_token = null;
let refresh_token = null;

let cachedNowPlaying = {
  playing: false
};

let isPolling = false;


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// LOGIN
app.get("/login", (req, res) => {
  const scope = "user-read-currently-playing";

  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      scope,
      redirect_uri: REDIRECT_URI
    });

  res.redirect(authUrl);
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

    const newAccess = tokenRes.data.access_token;
    const newRefresh = tokenRes.data.refresh_token;

    await supabase.from("spotify_tokens").upsert({
      id: 1,
      access_token: newAccess,
      refresh_token: newRefresh,
      expires_at: Date.now() + tokenRes.data.expires_in * 1000
    });

    access_token = newAccess;
    refresh_token = newRefresh;

    res.send("Autenticado! Ya podés cerrar esta pestaña.");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Error en autenticación");
  }
});

// REFRESH TOKEN
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

    // solo actualizar refresh_token si viene
    if (res.data.refresh_token) {
      refresh_token = res.data.refresh_token;
    }

    await supabase
      .from("spotify_tokens")
      .update({
        access_token,
        refresh_token,
        expires_at: Date.now() + res.data.expires_in * 1000,
        updated_at: new Date()
      })
      .eq("id", 1);
  } catch (err) {
    console.error("Error refrescando token:", err.response?.data || err.message);
  }
}

// NOW PLAYING
app.get("/now-playing", (req, res) => {
  res.json(cachedNowPlaying);
});

async function pollNowPlaying() {
  if (!access_token || isPolling) return;

  isPolling = true;

  try {
    // refrescar si hace falta
    const { data } = await supabase
      .from("spotify_tokens")
      .select("expires_at")
      .eq("id", 1)
      .single();

    if (data && Date.now() > data.expires_at) {
      await refreshAccessToken();
    }

    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      }
    );

    if (
      response.status === 204 ||
      !response.data ||
      !response.data.item
    ) {
      cachedNowPlaying = { 
        ...cachedNowPlaying,
        playing: false 
      };
    } else {
      const track = response.data.item;

      cachedNowPlaying = {
        playing: response.data.is_playing,
        title: track.name,
        artist: track.artists.map(a => a.name).join(", "),
        image: track.album.images?.[0]?.url,
        progress: response.data.progress_ms,
        duration: track.duration_ms
      };
    }
    if (!response.data.item) {
      console.log("No hay track activo");
    }

  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken();
    } else {
      console.error("Polling error:", err.response?.data || err.message);
    }
  }

  isPolling = false;
}

// Cargar tokens al iniciar
async function loadTokens() {
  const { data, error } = await supabase
    .from("spotify_tokens")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("Error cargando tokens:", error);
    return;
  }

  if (data) {
    access_token = data.access_token;
    refresh_token = data.refresh_token;
  }
}

function startPolling() {
  setInterval(pollNowPlaying, 2000);
}

// Init
async function start() {
  await loadTokens();
  await pollNowPlaying(); // obtener estado inicial
  startPolling();

  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}

start();