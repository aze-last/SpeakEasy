import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Audio } from "expo-av";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const SERVER_URL = "http://192.168.254.194:8000";
const SERVER_HEALTH_TIMEOUT_MS = 5000;
const SERVER_BOOT_TIMEOUT_MS = 60000;
const SERVER_RETRY_DELAY_MS = 3000;
const CONFIG_REQUEST_TIMEOUT_MS = 10000;
const TRANSCRIBE_AND_SUMMARIZE_TIMEOUT_MS = 30 * 60 * 1000;
const HISTORY_FILE_URI = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}speak-easy-history.json`
  : null;
const AUDIO_HISTORY_DIR_URI = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}speak-easy-audio`
  : null;
const MAX_HISTORY_ITEMS = 20;
const DEFAULT_SUMMARY_MODELS = ["qwen3:8b", "qwen2.5:7b"];

const theme = {
  bg: "#0A0A0F",
  surface: "#13131A",
  surfaceRaised: "#171924",
  border: "#24263A",
  accent: "#6C63FF",
  accentStrong: "#8B85FF",
  accentSoft: "rgba(108, 99, 255, 0.14)",
  danger: "#FF5B6E",
  dangerSoft: "rgba(255, 91, 110, 0.16)",
  success: "#3DDB92",
  text: "#F2F4FF",
  textSecondary: "#B1B7D4",
  textMuted: "#787E9C",
  track: "#1D2132",
  white: "#FFFFFF",
};

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatHistoryDate(value) {
  if (!value) {
    return "Recent";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Recent";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getLanguageLabel(language) {
  const normalized = String(language || "").toLowerCase();

  if (normalized.includes("en")) return "English";
  if (normalized.includes("tl") || normalized.includes("tag")) return "Tagalog";
  if (normalized.includes("ceb") || normalized.includes("bis")) return "Bisaya";
  if (!normalized) return "Unknown";

  return language;
}

function getMimeType(filename) {
  const extension = String(filename || "").split(".").pop()?.toLowerCase();

  switch (extension) {
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "video/mp4";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "m4a":
    default:
      return "audio/m4a";
  }
}

function normalizeActionItems(items) {
  if (Array.isArray(items)) {
    return items.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof items === "string") {
    return items
      .split("\n")
      .map((item) => item.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeKeyPoints(items) {
  return normalizeActionItems(items);
}

function mergeModelOptions(...lists) {
  const merged = [];

  lists.forEach((list) => {
    if (!Array.isArray(list)) {
      return;
    }

    list.forEach((item) => {
      const value = String(item || "").trim();

      if (value && !merged.includes(value)) {
        merged.push(value);
      }
    });
  });

  return merged;
}

function normalizeErrorMessage(error) {
  const errorName = String(error?.name || "");
  const message = String(error?.message || "");
  const lowerMessage = message.toLowerCase();
  const detail = error?.response?.data?.detail;

  if (
    errorName === "AbortError" ||
    lowerMessage.includes("abort") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("timeout")
  ) {
    return (
      "The app stopped waiting for the transcription request. " +
      "Large pre-recorded files can take several minutes on the local backend. " +
      "Reload the app and try again with the updated longer timeout."
    );
  }

  if (Array.isArray(detail)) {
    return detail.join("\n");
  }

  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }

  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message;
  }

  return "Something went wrong while processing the recording.";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getResponseErrorMessage(payload, status) {
  if (payload && typeof payload === "object") {
    const detail = payload.detail;

    if (Array.isArray(detail)) {
      return detail.join("\n");
    }

    if (typeof detail === "string" && detail.trim()) {
      return detail;
    }
  }

  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }

  return `The server returned ${status}.`;
}

function sanitizeFilename(value) {
  const normalized = String(value || "recording")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "recording";
}

async function ensureHistoryAudioDirectory() {
  if (!AUDIO_HISTORY_DIR_URI) {
    return null;
  }

  const info = await FileSystem.getInfoAsync(AUDIO_HISTORY_DIR_URI);

  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(AUDIO_HISTORY_DIR_URI, { intermediates: true });
  }

  return AUDIO_HISTORY_DIR_URI;
}

async function persistAudioFile(sourceUri, filename) {
  if (!sourceUri || !AUDIO_HISTORY_DIR_URI) {
    return null;
  }

  const directory = await ensureHistoryAudioDirectory();
  const extension = String(filename || "recording.m4a").split(".").pop()?.toLowerCase() || "m4a";
  const safeBaseName = sanitizeFilename(filename);
  const targetUri = `${directory}/${safeBaseName}-${Date.now()}.${extension}`;

  await FileSystem.copyAsync({
    from: sourceUri,
    to: targetUri,
  });

  return targetUri;
}

function removeTrimmedHistoryAudio(previousItems, nextItems) {
  const nextIds = new Set(nextItems.map((item) => item.id));

  previousItems
    .filter((item) => !nextIds.has(item.id) && item.audioUri)
    .forEach((item) => {
      FileSystem.deleteAsync(item.audioUri, { idempotent: true }).catch(() => undefined);
    });
}

function createHistoryEntry(result, filename, audioUri = null) {
  const transcription = result?.transcription || {};
  const summary = result?.summary || {};

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    filename: filename || "Untitled recording",
    audioUri,
    transcription: {
      text: transcription.text || "",
      language: transcription.language || "",
      duration: Number(transcription.duration || 0),
      segments: Array.isArray(transcription.segments) ? transcription.segments : [],
    },
    summary: {
      text: summary.text || "",
      key_points: normalizeKeyPoints(summary.key_points),
      action_items: normalizeActionItems(summary.action_items),
      model: summary.model || "",
      kv_cache_type: summary.kv_cache_type || null,
    },
  };
}

function resultFromHistoryItem(item) {
  return {
    audioUri: item?.audioUri || null,
    filename: item?.filename || "Untitled recording",
    transcription: item?.transcription || {},
    summary: item?.summary || {},
  };
}

async function loadHistoryEntries() {
  if (!HISTORY_FILE_URI) {
    return [];
  }

  try {
    const info = await FileSystem.getInfoAsync(HISTORY_FILE_URI);

    if (!info.exists) {
      return [];
    }

    const raw = await FileSystem.readAsStringAsync(HISTORY_FILE_URI);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistoryEntries(items) {
  if (!HISTORY_FILE_URI) {
    return;
  }

  await FileSystem.writeAsStringAsync(HISTORY_FILE_URI, JSON.stringify(items));
}

async function loadBackendConfig() {
  const fallbackModels = [...DEFAULT_SUMMARY_MODELS];

  try {
    const response = await fetchWithTimeout(
      `${SERVER_URL}/config`,
      { method: "GET" },
      CONFIG_REQUEST_TIMEOUT_MS
    );
    const payload = await readResponseBody(response);

    if (!response.ok) {
      throw new Error(getResponseErrorMessage(payload, response.status));
    }

    const models = mergeModelOptions(
      payload?.available_summary_models,
      payload?.summary_model_candidates,
      fallbackModels
    );
    const defaultModel = String(payload?.default_summary_model || "").trim();

    return {
      models: models.length > 0 ? models : fallbackModels,
      defaultModel: defaultModel || models[0] || fallbackModels[0],
      kvCacheType: payload?.ollama_kv_cache_type || null,
    };
  } catch {
    return {
      models: fallbackModels,
      defaultModel: fallbackModels[0],
      kvCacheType: null,
    };
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDocumentList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "<p class=\"muted\">None</p>";
  }

  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function buildResultDocumentHtml(result) {
  const transcription = result?.transcription || {};
  const summary = result?.summary || {};
  const keyPoints = normalizeKeyPoints(summary.key_points);
  const actionItems = normalizeActionItems(summary.action_items);
  const generatedAt = new Date().toLocaleString();
  const durationLabel = formatDuration(Math.round(transcription.duration || 0));

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SpeakEasy Export</title>
    <style>
      body { font-family: Calibri, Arial, sans-serif; color: #1f2937; margin: 40px; line-height: 1.55; }
      h1, h2 { color: #111827; margin-bottom: 8px; }
      .meta { margin: 0 0 24px; padding: 16px; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 12px; }
      .meta p { margin: 4px 0; }
      .section { margin-bottom: 24px; padding: 20px; border: 1px solid #e5e7eb; border-radius: 14px; }
      .muted { color: #6b7280; }
      ul { margin: 0; padding-left: 22px; }
      li { margin-bottom: 10px; }
      .transcript { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>SpeakEasy Result Export</h1>
    <div class="meta">
      <p><strong>Generated:</strong> ${escapeHtml(generatedAt)}</p>
      <p><strong>Language:</strong> ${escapeHtml(getLanguageLabel(transcription.language))}</p>
      <p><strong>Duration:</strong> ${escapeHtml(durationLabel)}</p>
      <p><strong>Model:</strong> ${escapeHtml(summary.model || "Unknown")}</p>
      <p><strong>KV Cache:</strong> ${escapeHtml(summary.kv_cache_type || "Default")}</p>
    </div>

    <div class="section">
      <h2>Summary</h2>
      <p>${escapeHtml(summary.text || "No summary available.")}</p>
    </div>

    <div class="section">
      <h2>Key Points</h2>
      ${renderDocumentList(keyPoints)}
    </div>

    <div class="section">
      <h2>Action Items</h2>
      ${renderDocumentList(actionItems)}
    </div>

    <div class="section">
      <h2>Transcript</h2>
      <div class="transcript">${escapeHtml(transcription.text || "No transcript available.")}</div>
    </div>
  </body>
</html>`;
}

async function createResultDocument(result) {
  if (!FileSystem.documentDirectory) {
    throw new Error("Document storage is unavailable on this device.");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileUri = `${FileSystem.documentDirectory}speak-easy-result-${timestamp}.doc`;
  const content = buildResultDocumentHtml(result);

  await FileSystem.writeAsStringAsync(fileUri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  return fileUri;
}

function ProcessingScreen({ step }) {
  const stages = [
    { id: "server", label: "Check local server" },
    { id: "upload", label: "Upload and transcribe" },
    { id: "summary", label: "Generate summary" },
    { id: "result", label: "Prepare results" },
  ];

  let activeIndex = 0;

  if (step.includes("Uploading")) activeIndex = 1;
  if (step.includes("transcribing")) activeIndex = 1;
  if (step.includes("Generating")) activeIndex = 2;
  if (step.includes("Preparing")) activeIndex = 3;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <View style={styles.processingContainer}>
        <View style={styles.processingCard}>
          <View style={styles.processingBadge}>
            <Text style={styles.processingBadgeText}>AI</Text>
          </View>
          <ActivityIndicator size="large" color={theme.accentStrong} />
          <Text style={styles.processingTitle}>Working on your recording</Text>
          <Text style={styles.processingStep}>{step || "Starting..."}</Text>
          <Text style={styles.processingNote}>
            Keep the app open while the audio is uploaded, transcribed, and summarized on your local server.
          </Text>
        </View>

        <View style={styles.processingSteps}>
          {stages.map((stage, index) => {
            const isDone = index < activeIndex;
            const isActive = index === activeIndex;

            return (
              <View
                key={stage.id}
                style={[
                  styles.processingStepRow,
                  isActive && styles.processingStepRowActive,
                ]}
              >
                <View
                  style={[
                    styles.processingStepNumber,
                    isDone && styles.processingStepNumberDone,
                    isActive && styles.processingStepNumberActive,
                  ]}
                >
                  <Text style={styles.processingStepNumberText}>{isDone ? "OK" : index + 1}</Text>
                </View>
                <Text
                  style={[
                    styles.processingStepLabel,
                    isActive && styles.processingStepLabelActive,
                  ]}
                >
                  {stage.label}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

function ResultScreen({ result, onBack }) {
  const transcription = result?.transcription || {};
  const summary = result?.summary || {};
  const keyPoints = normalizeKeyPoints(summary.key_points);
  const actionItems = normalizeActionItems(summary.action_items);
  const summaryModel = String(summary.model || "").trim();
  const summaryKvCacheType = String(summary.kv_cache_type || "").trim();
  const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
  const resultHeaderTopInset = Platform.OS === "android" ? (StatusBar.currentHeight || 0) + 10 : 12;
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const soundRef = useRef(null);
  const hasSavedAudio = Boolean(result?.audioUri);

  useEffect(() => {
    const activeSound = soundRef.current;
    soundRef.current = null;
    setIsPlayingAudio(false);
    setIsLoadingAudio(false);

    if (activeSound) {
      activeSound.unloadAsync().catch(() => undefined);
    }
  }, [result?.audioUri]);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => undefined);
        soundRef.current = null;
      }
    };
  }, []);

  const handlePlaybackStatusUpdate = (status) => {
    if (!status.isLoaded) {
      if (status.error) {
        setIsPlayingAudio(false);
        setIsLoadingAudio(false);
      }
      return;
    }

    setIsLoadingAudio(false);
    setIsPlayingAudio(status.isPlaying);

    if (status.didJustFinish) {
      const finishedSound = soundRef.current;
      soundRef.current = null;
      setIsPlayingAudio(false);
      finishedSound?.unloadAsync().catch(() => undefined);
    }
  };

  const toggleAudioPlayback = async () => {
    if (!hasSavedAudio || isLoadingAudio) {
      return;
    }

    try {
      if (soundRef.current) {
        const activeSound = soundRef.current;
        soundRef.current = null;
        setIsPlayingAudio(false);
        await activeSound.stopAsync().catch(() => undefined);
        await activeSound.unloadAsync().catch(() => undefined);
        return;
      }

      setIsLoadingAudio(true);

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: result.audioUri },
        { shouldPlay: true },
        handlePlaybackStatusUpdate
      );

      soundRef.current = sound;
    } catch (error) {
      setIsLoadingAudio(false);
      setIsPlayingAudio(false);
      Alert.alert("Playback error", `Could not play saved audio.\n\n${normalizeErrorMessage(error)}`);
    }
  };

  const exportDocument = async () => {
    if (isExporting) {
      return;
    }

    try {
      setIsExporting(true);
      const fileUri = await createResultDocument(result);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "application/msword",
          dialogTitle: "Export SpeakEasy document",
          UTI: "com.microsoft.word.doc",
        });
      } else {
        Alert.alert("Document ready", `Saved to:\n\n${fileUri}`);
      }
    } catch (error) {
      Alert.alert("Export error", `Could not create the document.\n\n${normalizeErrorMessage(error)}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      <View style={[styles.resultHeader, { paddingTop: resultHeaderTopInset }]}>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>New recording</Text>
        </TouchableOpacity>
        <Text style={styles.resultHeaderTitle}>Results</Text>
        <View style={styles.resultHeaderSpacer} />
      </View>

      <ScrollView style={styles.resultScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.metaRow}>
          <View style={styles.metaBadge}>
            <Text style={styles.metaBadgeText}>{getLanguageLabel(transcription.language)}</Text>
          </View>
          <View style={styles.metaBadge}>
            <Text style={styles.metaBadgeText}>
              {formatDuration(Math.round(transcription.duration || 0))}
            </Text>
          </View>
          {summaryModel ? (
            <View style={styles.metaBadge}>
              <Text style={styles.metaBadgeText}>{summaryModel}</Text>
            </View>
          ) : null}
          {summaryKvCacheType ? (
            <View style={styles.metaBadge}>
              <Text style={styles.metaBadgeText}>KV {summaryKvCacheType}</Text>
            </View>
          ) : null}
        </View>

        {hasSavedAudio ? (
          <TouchableOpacity
            style={styles.playbackButton}
            onPress={toggleAudioPlayback}
            activeOpacity={0.85}
          >
            <Text style={styles.playbackButtonText}>
              {isLoadingAudio
                ? "Loading audio..."
                : isPlayingAudio
                  ? "Stop saved audio"
                  : "Play saved audio"}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.playbackNotice}>
            <Text style={styles.playbackNoticeText}>
              Saved audio replay is available for new recordings from this update onward.
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.exportButton}
          onPress={exportDocument}
          activeOpacity={0.85}
        >
          <Text style={styles.exportButtonText}>
            {isExporting ? "Creating document..." : "Export Word document"}
          </Text>
        </TouchableOpacity>

        <View style={styles.resultCard}>
          <View style={styles.cardHeader}>
            <View style={styles.cardMarker}>
              <Text style={styles.cardMarkerText}>AI</Text>
            </View>
            <Text style={styles.cardTitle}>Summary</Text>
          </View>
          <Text style={styles.cardBody}>
            {summary.text?.trim() || "No summary was returned by the server."}
          </Text>
        </View>

        {keyPoints.length > 0 && (
          <View style={styles.resultCard}>
            <View style={styles.cardHeader}>
              <View style={styles.cardMarker}>
                <Text style={styles.cardMarkerText}>KP</Text>
              </View>
              <Text style={styles.cardTitle}>Key points</Text>
            </View>
            <View style={styles.actionList}>
              {keyPoints.map((item, index) => (
                <View key={`${item}-${index}`} style={styles.actionRow}>
                  <View style={styles.actionDot} />
                  <Text style={styles.actionText}>{item}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {actionItems.length > 0 && (
          <View style={styles.resultCard}>
            <View style={styles.cardHeader}>
              <View style={styles.cardMarker}>
                <Text style={styles.cardMarkerText}>DO</Text>
              </View>
              <Text style={styles.cardTitle}>Action items</Text>
            </View>
            <View style={styles.actionList}>
              {actionItems.map((item, index) => (
                <View key={`${item}-${index}`} style={styles.actionRow}>
                  <View style={styles.actionDot} />
                  <Text style={styles.actionText}>{item}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.resultCard}>
          <View style={styles.cardHeader}>
            <View style={styles.cardMarker}>
              <Text style={styles.cardMarkerText}>TX</Text>
            </View>
            <Text style={styles.cardTitle}>Transcript</Text>
          </View>
          <Text style={styles.transcriptText}>
            {transcription.text?.trim() || "No transcript was returned by the server."}
          </Text>
        </View>

        {segments.length > 0 && (
          <View style={styles.resultCard}>
            <View style={styles.cardHeader}>
              <View style={styles.cardMarker}>
                <Text style={styles.cardMarkerText}>TL</Text>
              </View>
              <Text style={styles.cardTitle}>Timeline</Text>
            </View>
            <View style={styles.timelineList}>
              {segments.map((segment, index) => (
                <View key={`${segment.start}-${index}`} style={styles.timelineRow}>
                  <Text style={styles.timelineTime}>{formatTimestamp(segment.start)}</Text>
                  <Text style={styles.timelineText}>{segment.text?.trim() || "-"}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.resultBottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  const [screen, setScreen] = useState("home");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState("");
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [availableSummaryModels, setAvailableSummaryModels] = useState(DEFAULT_SUMMARY_MODELS);
  const [selectedSummaryModel, setSelectedSummaryModel] = useState(DEFAULT_SUMMARY_MODELS[0]);
  const [ollamaKvCacheType, setOllamaKvCacheType] = useState(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);

  const recordingRef = useRef(null);
  const timerRef = useRef(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef(null);

  const windowWidth = Dimensions.get("window").width;
  const recordButtonSize = Math.min(windowWidth * 0.5, 188);
  const recordInnerSize = Math.round(recordButtonSize * 0.72);
  const androidTopInset = Platform.OS === "android" ? StatusBar.currentHeight || 0 : 0;
  const topPadding = Math.max(18, androidTopInset + 12);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const resetAudioMode = async () => {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false,
    });
  };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();

    return () => {
      stopTimer();
      pulseLoopRef.current?.stop();

      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => undefined);
      }

      resetAudioMode().catch(() => undefined);
    };
  }, [fadeAnim]);

  useEffect(() => {
    pulseLoopRef.current?.stop();

    if (isRecording) {
      pulseLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.06,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ])
      );

      pulseLoopRef.current.start();
      return undefined;
    }

    pulseAnim.setValue(1);
    return undefined;
  }, [isRecording, pulseAnim]);

  useEffect(() => {
    let isActive = true;

    loadHistoryEntries()
      .then((items) => {
        if (isActive) {
          setHistory(items);
        }
      })
      .catch(() => undefined);

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    loadBackendConfig()
      .then((config) => {
        if (!isActive) {
          return;
        }

        setAvailableSummaryModels(config.models);
        setSelectedSummaryModel((current) => {
          if (current && config.models.includes(current)) {
            return current;
          }

          return config.defaultModel || config.models[0] || DEFAULT_SUMMARY_MODELS[0];
        });
        setOllamaKvCacheType(config.kvCacheType || null);
      })
      .catch(() => undefined);

    return () => {
      isActive = false;
    };
  }, []);

  const processAudio = async (uri, filename) => {
    setResult(null);
    setScreen("home");
    setIsProcessing(true);
    setProcessingStep("Checking local server");

    try {
      const startedAt = Date.now();
      let serverReady = false;

      while (!serverReady) {
        const elapsedMs = Date.now() - startedAt;

        if (elapsedMs >= SERVER_BOOT_TIMEOUT_MS) {
          throw new Error(
            `Cannot reach server at ${SERVER_URL}. Run start_backend.bat on your PC and wait 30 to 45 seconds for Whisper to load. If your PC IP changed, update SERVER_URL in App.js.`
          );
        }

        if (elapsedMs < 10000) {
          setProcessingStep("Starting local server");
        } else {
          setProcessingStep(`Waiting for local server (${Math.ceil(elapsedMs / 1000)}s)`);
        }

        try {
          const healthResponse = await fetchWithTimeout(
            `${SERVER_URL}/health`,
            { method: "GET" },
            SERVER_HEALTH_TIMEOUT_MS
          );

          if (!healthResponse.ok) {
            throw new Error(`Health check failed with status ${healthResponse.status}.`);
          }

          serverReady = true;
        } catch (healthError) {
          await delay(SERVER_RETRY_DELAY_MS);
        }
      }

      const formData = new FormData();
      formData.append("file", {
        uri,
        name: filename,
        type: getMimeType(filename),
      });

      if (selectedSummaryModel) {
        formData.append("summary_model", selectedSummaryModel);
      }

      setProcessingStep("Uploading and transcribing");

      const response = await fetchWithTimeout(
        `${SERVER_URL}/transcribe-and-summarize`,
        {
          method: "POST",
          body: formData,
        },
        TRANSCRIBE_AND_SUMMARIZE_TIMEOUT_MS
      );

      const responseData = await readResponseBody(response);

      if (!response.ok) {
        throw new Error(getResponseErrorMessage(responseData, response.status));
      }

      if (!responseData?.success || !responseData?.transcription || !responseData?.summary) {
        throw new Error("The backend returned an incomplete response.");
      }

      setProcessingStep("Generating summary");
      await new Promise((resolve) => setTimeout(resolve, 250));
      setProcessingStep("Preparing results");

      const savedAudioUri = await persistAudioFile(uri, filename).catch(() => null);
      const resultPayload = {
        ...responseData,
        audioUri: savedAudioUri,
        filename,
      };
      const historyEntry = createHistoryEntry(resultPayload, filename, savedAudioUri);

      setHistory((current) => {
        const next = [historyEntry, ...current].slice(0, MAX_HISTORY_ITEMS);
        removeTrimmedHistoryAudio(current, next);
        saveHistoryEntries(next).catch(() => undefined);
        return next;
      });
      setResult(resultPayload);
      setScreen("result");
      setRecordingDuration(0);
    } catch (error) {
      Alert.alert("Processing failed", normalizeErrorMessage(error));
    } finally {
      setIsProcessing(false);
      setProcessingStep("");
    }
  };

  const startRecording = async () => {
    if (isProcessing || isRecording) {
      return;
    }

    try {
      const permission = await Audio.requestPermissionsAsync();

      if (permission.status !== "granted") {
        Alert.alert("Microphone required", "Allow microphone access to record teacher feedback.");
        return;
      }

      stopTimer();
      setResult(null);
      setScreen("home");
      setRecordingDuration(0);

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      recordingRef.current = recording;
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        setRecordingDuration((current) => current + 1);
      }, 1000);
    } catch (error) {
      await resetAudioMode().catch(() => undefined);
      Alert.alert("Recording error", `Could not start recording.\n\n${normalizeErrorMessage(error)}`);
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) {
      return;
    }

    const activeRecording = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    stopTimer();

    try {
      await activeRecording.stopAndUnloadAsync();
      await resetAudioMode();

      const uri = activeRecording.getURI();

      if (!uri) {
        throw new Error("The recording file could not be saved.");
      }

      await processAudio(uri, `recording-${Date.now()}.m4a`);
    } catch (error) {
      await resetAudioMode().catch(() => undefined);
      Alert.alert("Recording error", `Could not finish recording.\n\n${normalizeErrorMessage(error)}`);
    }
  };

  const pickFile = async () => {
    if (isProcessing) {
      return;
    }

    if (isRecording) {
      Alert.alert("Finish recording first", "Stop the current recording before uploading a file.");
      return;
    }

    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["audio/*", "video/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (picked.canceled || !picked.assets?.[0]) {
        return;
      }

      const asset = picked.assets[0];

      if (!asset.uri) {
        throw new Error("The selected file could not be opened.");
      }

      await processAudio(asset.uri, asset.name || `upload-${Date.now()}.m4a`);
    } catch (error) {
      Alert.alert("Upload error", normalizeErrorMessage(error));
    }
  };

  const resetApp = () => {
    stopTimer();
    setIsRecording(false);
    setIsProcessing(false);
    setProcessingStep("");
    setRecordingDuration(0);
    setResult(null);
    setIsModelMenuOpen(false);
    setScreen("home");
  };

  const openHistoryItem = (item) => {
    setResult(resultFromHistoryItem(item));
    setScreen("result");
  };

  if (isProcessing) {
    return <ProcessingScreen step={processingStep} />;
  }

  if (screen === "result" && result) {
    return <ResultScreen result={result} onBack={resetApp} />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView
        style={styles.homeScroll}
        contentContainerStyle={[styles.container, { paddingTop: topPadding }]}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View style={{ opacity: fadeAnim }}>
          <View style={styles.heroCard}>
            <View style={styles.headerRow}>
              <View style={styles.brandRow}>
                <View style={styles.brandDot} />
                <Text style={styles.brandText}>SpeakEasy</Text>
              </View>
              <View style={styles.languagePill}>
                <Text style={styles.languagePillText}>EN TL CEB</Text>
              </View>
            </View>

            <Text style={styles.heroTitle}>Capture feedback fast</Text>
            <Text style={styles.heroSubtitle}>
              Record your teacher&apos;s feedback, then get a clean transcript, summary, and action items in one place.
            </Text>
          </View>

          <View style={styles.modelCard}>
            <Text style={styles.sectionEyebrow}>Summary model</Text>
            <TouchableOpacity
              style={styles.modelSelector}
              onPress={() => setIsModelMenuOpen((current) => !current)}
              activeOpacity={0.88}
            >
              <View style={styles.modelSelectorCopy}>
                <Text style={styles.modelSelectorLabel}>Chosen model</Text>
                <Text style={styles.modelSelectorValue}>{selectedSummaryModel}</Text>
              </View>
              <Text style={styles.modelSelectorAction}>
                {isModelMenuOpen ? "Hide" : "Choose"}
              </Text>
            </TouchableOpacity>

            <Text style={styles.modelRuntimeText}>
              {ollamaKvCacheType
                ? `KV cache experiment active: ${ollamaKvCacheType}`
                : "KV cache experiment is not enabled in the current backend session."}
            </Text>

            {isModelMenuOpen ? (
              <View style={styles.modelOptionsList}>
                {availableSummaryModels.map((modelName) => {
                  const isSelected = modelName === selectedSummaryModel;

                  return (
                    <TouchableOpacity
                      key={modelName}
                      style={[
                        styles.modelOptionButton,
                        isSelected && styles.modelOptionButtonSelected,
                      ]}
                      onPress={() => {
                        setSelectedSummaryModel(modelName);
                        setIsModelMenuOpen(false);
                      }}
                      activeOpacity={0.88}
                    >
                      <Text
                        style={[
                          styles.modelOptionText,
                          isSelected && styles.modelOptionTextSelected,
                        ]}
                      >
                        {modelName}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
          </View>

          <View style={styles.recordPanel}>
            <Text style={styles.sectionEyebrow}>Quick capture</Text>
            <View style={styles.recordSection}>
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <TouchableOpacity
                  style={[
                    styles.recordButton,
                    {
                      width: recordButtonSize,
                      height: recordButtonSize,
                      borderRadius: recordButtonSize / 2,
                    },
                    isRecording && styles.recordButtonActive,
                  ]}
                  onPress={isRecording ? stopRecording : startRecording}
                  activeOpacity={0.9}
                  disabled={isProcessing}
                >
                  <View
                    style={[
                      styles.recordInner,
                      {
                        width: recordInnerSize,
                        height: recordInnerSize,
                        borderRadius: recordInnerSize / 2,
                      },
                      isRecording && styles.recordInnerActive,
                    ]}
                  >
                    {isRecording ? (
                      <View style={styles.stopIcon} />
                    ) : (
                      <View style={styles.micGlyph}>
                        <View style={styles.micHead} />
                        <View style={styles.micStem} />
                        <View style={styles.micBase} />
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              </Animated.View>

              {isRecording ? (
                <View style={styles.recordingInfo}>
                  <View style={styles.liveRow}>
                    <View style={styles.liveDot} />
                    <Text style={styles.liveLabel}>Recording live</Text>
                  </View>
                  <Text style={styles.timerText}>{formatDuration(recordingDuration)}</Text>
                  <Text style={styles.recordHint}>Tap the button again to stop and process</Text>
                </View>
              ) : (
                <View style={styles.recordingInfo}>
                  <Text style={styles.recordIdleTitle}>Tap to start recording</Text>
                  <Text style={styles.recordHint}>
                    The button now stays lower in the safe touch zone for easier tapping.
                  </Text>
                </View>
              )}
            </View>
          </View>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={[styles.uploadCard, isRecording && styles.uploadCardDisabled]}
            onPress={pickFile}
            activeOpacity={0.85}
            disabled={isRecording || isProcessing}
          >
            <View style={styles.uploadBadge}>
              <Text style={styles.uploadBadgeText}>UP</Text>
            </View>
            <View style={styles.uploadCopy}>
              <Text style={styles.uploadTitle}>Upload audio or video</Text>
              <Text style={styles.uploadSubtitle}>MP3, MP4, M4A, WAV, and OGG are supported.</Text>
            </View>
          </TouchableOpacity>

          <View style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.historyTitle}>Recording history</Text>
                <Text style={styles.historySubtitle}>
                  Reopen older transcripts, summaries, and action items.
                </Text>
              </View>
              <View style={styles.historyCountBadge}>
                <Text style={styles.historyCountText}>{history.length}</Text>
              </View>
            </View>

            {history.length === 0 ? (
              <View style={styles.historyEmptyState}>
                <Text style={styles.historyEmptyTitle}>No recordings yet</Text>
                <Text style={styles.historyEmptyText}>
                  After each processed recording, the transcript and summary will appear here.
                </Text>
              </View>
            ) : (
              <View style={styles.historyList}>
                {history.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.historyRow}
                    onPress={() => openHistoryItem(item)}
                    activeOpacity={0.88}
                  >
                    <View style={styles.historyRowTop}>
                      <Text style={styles.historyFilename} numberOfLines={1}>
                        {item.filename || "Recording"}
                      </Text>
                      <Text style={styles.historyDate}>{formatHistoryDate(item.createdAt)}</Text>
                    </View>

                    <View style={styles.historyMetaRow}>
                      <View style={styles.historyMetaBadge}>
                        <Text style={styles.historyMetaText}>
                          {getLanguageLabel(item?.transcription?.language)}
                        </Text>
                      </View>
                      <View style={styles.historyMetaBadge}>
                        <Text style={styles.historyMetaText}>
                          {formatDuration(Math.round(item?.transcription?.duration || 0))}
                        </Text>
                      </View>
                      {item?.summary?.model ? (
                        <View style={styles.historyMetaBadge}>
                          <Text style={styles.historyMetaText}>{item.summary.model}</Text>
                        </View>
                      ) : null}
                      {item?.summary?.kv_cache_type ? (
                        <View style={styles.historyMetaBadge}>
                          <Text style={styles.historyMetaText}>
                            KV {item.summary.kv_cache_type}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    <Text style={styles.historyPreview} numberOfLines={2}>
                      {item?.transcription?.text?.trim() || "Transcript will appear here once speech is detected."}
                    </Text>

                    <Text style={styles.historySummaryPreview} numberOfLines={2}>
                      {item?.summary?.text?.trim() || "Summary unavailable for this recording."}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          <View style={styles.infoGrid}>
            <View style={styles.infoCard}>
              <Text style={styles.infoCardLabel}>Private</Text>
              <Text style={styles.infoCardValue}>Runs on your PC</Text>
            </View>
            <View style={styles.infoCard}>
              <Text style={styles.infoCardLabel}>Smart</Text>
              <Text style={styles.infoCardValue}>Transcript plus summary</Text>
            </View>
          </View>

          <Text style={styles.footerNote}>
            Run `start_backend.bat` first, then wait around 45 seconds for the local server to finish loading Whisper. If your PC IP changed, update `SERVER_URL` in App.js before recording.
          </Text>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  container: {
    paddingHorizontal: 22,
    paddingBottom: 34,
  },
  homeScroll: {
    flex: 1,
  },
  heroCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 24,
    padding: 20,
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  brandDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: theme.accent,
    marginRight: 10,
  },
  brandText: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  languagePill: {
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  languagePillText: {
    color: theme.accentStrong,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  heroTitle: {
    color: theme.text,
    fontSize: 28,
    fontWeight: "800",
    lineHeight: 34,
    marginBottom: 10,
  },
  heroSubtitle: {
    color: theme.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  modelCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
    marginBottom: 22,
  },
  modelSelector: {
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modelSelectorCopy: {
    flex: 1,
    paddingRight: 12,
  },
  modelSelectorLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.9,
    marginBottom: 6,
  },
  modelSelectorValue: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "800",
  },
  modelSelectorAction: {
    color: theme.accentStrong,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  modelRuntimeText: {
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  modelOptionsList: {
    gap: 10,
    marginTop: 14,
  },
  modelOptionButton: {
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  modelOptionButtonSelected: {
    borderColor: theme.accent + "88",
    backgroundColor: theme.accentSoft,
  },
  modelOptionText: {
    color: theme.textSecondary,
    fontSize: 14,
    fontWeight: "700",
  },
  modelOptionTextSelected: {
    color: theme.text,
  },
  recordPanel: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 22,
    marginBottom: 22,
  },
  sectionEyebrow: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 14,
    textAlign: "center",
  },
  recordSection: {
    alignItems: "center",
    paddingTop: 6,
  },
  recordButton: {
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: theme.accentSoft,
    borderWidth: 2,
    borderColor: theme.accent,
    marginBottom: 20,
  },
  recordButtonActive: {
    backgroundColor: theme.dangerSoft,
    borderColor: theme.danger,
  },
  recordInner: {
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: theme.accent,
  },
  recordInnerActive: {
    backgroundColor: theme.danger,
  },
  micGlyph: {
    alignItems: "center",
    justifyContent: "center",
  },
  micHead: {
    width: 28,
    height: 36,
    borderRadius: 14,
    borderWidth: 4,
    borderColor: theme.white,
  },
  micStem: {
    width: 4,
    height: 18,
    backgroundColor: theme.white,
    marginTop: 6,
    borderRadius: 2,
  },
  micBase: {
    width: 28,
    height: 4,
    backgroundColor: theme.white,
    marginTop: 6,
    borderRadius: 2,
  },
  stopIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: theme.white,
  },
  recordingInfo: {
    alignItems: "center",
    maxWidth: 260,
  },
  liveRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.danger,
    marginRight: 8,
  },
  liveLabel: {
    color: theme.danger,
    fontSize: 13,
    fontWeight: "700",
  },
  timerText: {
    color: theme.text,
    fontSize: 36,
    fontWeight: "800",
    marginBottom: 4,
  },
  recordIdleTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  recordHint: {
    color: theme.textSecondary,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.border,
  },
  dividerText: {
    color: theme.textMuted,
    fontSize: 13,
    marginHorizontal: 14,
  },
  uploadCard: {
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 20,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
  },
  historyCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 18,
  },
  historyHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14,
  },
  historyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 4,
  },
  historySubtitle: {
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    maxWidth: 240,
  },
  historyCountBadge: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 10,
  },
  historyCountText: {
    color: theme.accentStrong,
    fontSize: 13,
    fontWeight: "800",
  },
  historyEmptyState: {
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 18,
    padding: 16,
  },
  historyEmptyTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 6,
  },
  historyEmptyText: {
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  historyList: {
    gap: 12,
  },
  historyRow: {
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 18,
    padding: 14,
  },
  historyRowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  historyFilename: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
    marginRight: 10,
  },
  historyDate: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  historyMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 10,
  },
  historyMetaBadge: {
    backgroundColor: theme.track,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 8,
    marginBottom: 8,
  },
  historyMetaText: {
    color: theme.textSecondary,
    fontSize: 11,
    fontWeight: "700",
  },
  historyPreview: {
    color: theme.text,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 8,
  },
  historySummaryPreview: {
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  uploadCardDisabled: {
    opacity: 0.5,
  },
  uploadBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  uploadBadgeText: {
    color: theme.accentStrong,
    fontSize: 13,
    fontWeight: "800",
  },
  uploadCopy: {
    flex: 1,
  },
  uploadTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 4,
  },
  uploadSubtitle: {
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  infoGrid: {
    flexDirection: "row",
    marginBottom: 16,
  },
  infoCard: {
    flex: 1,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 18,
    padding: 16,
  },
  infoCardLabel: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
  },
  infoCardValue: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  footerNote: {
    color: theme.textMuted,
    fontSize: 11,
    lineHeight: 17,
    textAlign: "center",
  },
  processingContainer: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  processingCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 24,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: "center",
    marginBottom: 18,
  },
  processingBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 18,
  },
  processingBadgeText: {
    color: theme.accentStrong,
    fontWeight: "800",
    fontSize: 14,
  },
  processingTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 18,
    marginBottom: 10,
    textAlign: "center",
  },
  processingStep: {
    color: theme.accentStrong,
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 10,
    textAlign: "center",
  },
  processingNote: {
    color: theme.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  processingSteps: {
    gap: 10,
  },
  processingStepRow: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  processingStepRowActive: {
    borderColor: theme.accent + "88",
    backgroundColor: theme.surfaceRaised,
  },
  processingStepNumber: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.track,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  processingStepNumberDone: {
    backgroundColor: theme.success,
  },
  processingStepNumberActive: {
    backgroundColor: theme.accent,
  },
  processingStepNumberText: {
    color: theme.white,
    fontSize: 11,
    fontWeight: "800",
  },
  processingStepLabel: {
    color: theme.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  processingStepLabelActive: {
    color: theme.text,
  },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backButton: {
    width: 126,
    paddingVertical: 8,
  },
  backButtonText: {
    color: theme.accentStrong,
    fontSize: 14,
    fontWeight: "700",
  },
  resultHeaderTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "800",
  },
  resultHeaderSpacer: {
    width: 126,
  },
  resultScroll: {
    flex: 1,
    paddingHorizontal: 16,
  },
  playbackButton: {
    alignSelf: "flex-start",
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 11,
    marginBottom: 18,
  },
  playbackButtonText: {
    color: theme.accentStrong,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  playbackNotice: {
    marginBottom: 18,
  },
  playbackNoticeText: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  exportButton: {
    alignSelf: "flex-start",
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 11,
    marginBottom: 18,
  },
  exportButtonText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 16,
    marginBottom: 12,
  },
  metaBadge: {
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  metaBadgeText: {
    color: theme.accentStrong,
    fontSize: 12,
    fontWeight: "700",
  },
  resultCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  cardMarker: {
    minWidth: 36,
    height: 28,
    borderRadius: 10,
    backgroundColor: theme.accentSoft,
    borderWidth: 1,
    borderColor: theme.accent + "55",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
    marginRight: 10,
  },
  cardMarkerText: {
    color: theme.accentStrong,
    fontSize: 11,
    fontWeight: "800",
  },
  cardTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "800",
  },
  cardBody: {
    color: theme.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  actionList: {
    gap: 10,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  actionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.success,
    marginTop: 6,
    marginRight: 10,
  },
  actionText: {
    flex: 1,
    color: theme.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  transcriptText: {
    color: theme.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  timelineList: {
    gap: 10,
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  timelineTime: {
    width: 50,
    color: theme.accentStrong,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 2,
  },
  timelineText: {
    flex: 1,
    color: theme.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  resultBottomSpacer: {
    height: 28,
  },
});
