/* eslint-disable no-undef */
document.addEventListener("DOMContentLoaded", () => {
  const languageSelect = document.getElementById("languages");
  const voiceSelect = document.getElementById("voices");
  const rateInput = document.getElementById("rate");
  const rateValue = document.getElementById("rateValue");
  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusText = document.getElementById("statusText");
  const originalText = document.getElementById("originalText");
  const translatedText = document.getElementById("translatedText");
  const readTranslatedBtn = document.getElementById("readTranslatedBtn");

  let currentSettings = {
    lang: "en",
    voice: "",
    rate: 1.0
  };

  let currentText = "";
  let availableVoices = [];
  let isPlaying = false;
  let isPaused = false;

  chrome.storage.local.get(["speechSettings", "selectedText", "translationNeeded", "translatedText", "translationError"], (result) => {
    if (result.speechSettings) {
      currentSettings = result.speechSettings;
      languageSelect.value = currentSettings.lang;
      rateInput.value = currentSettings.rate;
      updateDisplayValues();
    }

    if (result.selectedText) {
      currentText = result.selectedText;
      originalText.textContent = result.selectedText;
      
      if (result.translationNeeded) {
        translateCurrentText();
      } else if (result.translatedText) {
        translatedText.textContent = result.translatedText;
      } else if (result.translationError) {
        translatedText.textContent = `Error: ${result.translationError}`;
      }
    }
  });


  function populateVoices() {
    chrome.tts.getVoices((voices) => {
      availableVoices = voices;
      updateVoiceList();
    });
  }


  function updateVoiceList() {
    const selectedLang = languageSelect.value;
    voiceSelect.innerHTML = "";

    const matchingVoices = availableVoices.filter(voice => 
      voice.lang.startsWith(selectedLang)
    );

    if (matchingVoices.length === 0) {
      const fallbackVoices = availableVoices.filter(voice => 
        voice.lang.includes(selectedLang.substring(0, 2))
      );
      
      if (fallbackVoices.length > 0) {
        fallbackVoices.forEach(voice => addVoiceOption(voice));
      } else {
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Default voice";
        voiceSelect.appendChild(defaultOption);
      }
    } else {
      matchingVoices.forEach(voice => addVoiceOption(voice));
    }

    if (currentSettings.voice) {
      const voiceExists = Array.from(voiceSelect.options).some(
        option => option.value === currentSettings.voice
      );
      if (voiceExists) {
        voiceSelect.value = currentSettings.voice;
      }
    }
  }

  function addVoiceOption(voice) {
    const option = document.createElement("option");
    option.value = voice.voiceName;
    
    let displayName = voice.voiceName;
    if (voice.name) {
      displayName = voice.name;
    } else {
      displayName = voice.voiceName
        .replace(/^[a-z]{2}-[A-Z]{2}-/, '')
        .replace(/Standard-/, '')
        .replace(/Wavenet-/, '');
    }
    
    option.textContent = displayName;
    voiceSelect.appendChild(option);
  }

  function updateDisplayValues() {
    rateValue.textContent = rateInput.value;
  }

  function saveSettings() {
    currentSettings.lang = languageSelect.value;
    currentSettings.voice = voiceSelect.value;
    currentSettings.rate = parseFloat(rateInput.value);
    chrome.storage.local.set({ speechSettings: currentSettings });
  }

  function updateStatus(status) {
    statusText.textContent = status;
  }


  function translateCurrentText() {
    if (!currentText) return;

    updateStatus("Translating...");
    translatedText.textContent = "Translating...";

    const services = [
      {
        url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${currentSettings.lang}&dt=t&q=${encodeURIComponent(currentText)}`,
        parseResponse: (data) => {
          if (Array.isArray(data) && data[0]) {
            return data[0]
              .map(item => item[0])
              .filter(text => text)
              .join(' ');
          }
          return '';
        }
      },
      {
        url: `https://api.mymemory.translated.net/get?q=${encodeURIComponent(currentText)}&langpair=auto|${currentSettings.lang}`,
        parseResponse: (data) => data.responseData.translatedText
      },
      {
        url: `https://libretranslate.de/translate`,
        method: 'POST',
        body: JSON.stringify({
          q: currentText,
          source: 'auto',
          target: currentSettings.lang
        }),
        headers: {
          'Content-Type': 'application/json'
        },
        parseResponse: (data) => data.translatedText
      }
    ];

    let currentServiceIndex = 0;

    function tryNextService() {
      if (currentServiceIndex >= services.length) {
        updateStatus("Translation failed");
        translatedText.textContent = "Translation failed. Please try again.";
        chrome.storage.local.set({ translationError: "All translation services failed" });
        return;
      }

      const service = services[currentServiceIndex];
      const options = {
        method: service.method || 'GET',
        headers: service.headers || {}
      };

      if (service.body) {
        options.body = service.body;
      }

      fetch(service.url, options)
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
        })
        .then(data => {
          const translated = service.parseResponse(data);
          if (translated && translated.trim()) {
            translatedText.textContent = translated;
            updateStatus("Translation complete");
            chrome.storage.local.set({ 
              translatedText: translated,
              translationNeeded: false,
              translationError: null
            });
          } else {
            throw new Error('Empty translation received');
          }
        })
        .catch(error => {
          console.error(`Translation service ${currentServiceIndex + 1} failed:`, error);
          currentServiceIndex++;
          tryNextService();
        });
    }

    tryNextService();
  }

  function readTranslatedText() {
    if (!translatedText.textContent || translatedText.textContent === "Translating...") {
      updateStatus("No text to read");
      return;
    }

    chrome.tts.speak(translatedText.textContent, {
      lang: currentSettings.lang,
      voiceName: currentSettings.voice,
      rate: currentSettings.rate,
      onEvent: (event) => {
        if (event.type === 'end') {
          updateStatus("Ready");
          isPlaying = false;
          updateButtonStates();
        }
      }
    });

    isPlaying = true;
    updateStatus("Reading translation");
    updateButtonStates();
  }

  function playCurrentText() {
    if (!currentText) {
      updateStatus("No text selected");
      return;
    }

    chrome.tts.speak(currentText, {
      lang: currentSettings.lang,
      voiceName: currentSettings.voice,
      rate: currentSettings.rate,
      onEvent: (event) => {
        if (event.type === 'end') {
          updateStatus("Ready");
          isPlaying = false;
          updateButtonStates();
        }
      }
    });

    isPlaying = true;
    updateStatus("Reading");
    updateButtonStates();
  }

  function updateButtonStates() {
    playBtn.disabled = isPlaying;
    pauseBtn.disabled = !isPlaying || isPaused;
    resumeBtn.disabled = !isPaused;
    stopBtn.disabled = !isPlaying;
  }

  languageSelect.addEventListener("change", () => {
    updateVoiceList();
    saveSettings();
    if (currentText) {
      translateCurrentText();
    }
  });

  voiceSelect.addEventListener("change", saveSettings);

  rateInput.addEventListener("input", () => {
    updateDisplayValues();
    saveSettings();
  });

  playBtn.addEventListener("click", playCurrentText);
  pauseBtn.addEventListener("click", () => {
    chrome.tts.pause();
    isPaused = true;
    updateStatus("Paused");
    updateButtonStates();
  });
  resumeBtn.addEventListener("click", () => {
    chrome.tts.resume();
    isPaused = false;
    updateStatus("Reading");
    updateButtonStates();
  });
  stopBtn.addEventListener("click", () => {
    chrome.tts.stop();
    isPlaying = false;
    isPaused = false;
    updateStatus("Ready");
    updateButtonStates();
  });
  readTranslatedBtn.addEventListener("click", readTranslatedText);

  populateVoices();
  updateButtonStates();
});