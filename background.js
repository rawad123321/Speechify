/* eslint-disable no-undef */

let chunks = [];
let chunkIndex = 0;
let isPaused = false;
let currentSettings = {
  lang: "en",
  voice: "",
  rate: 1.0
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "speakText",
    title: "Speechify",
    contexts: ["selection"],
  });
  chrome.storage.local.get(["speechSettings"], (result) => {
    if (result.speechSettings) {
      currentSettings = result.speechSettings;
    }
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "speakText" && info.selectionText) {
    chrome.storage.local.set({ 
      selectedText: info.selectionText,
      translationNeeded: true 
    });
    
    chrome.action.openPopup();
    
    startSpeech(info.selectionText);
  }
});


function splitText(text, maxLength = 200) {
 
  if (currentSettings.lang === "ar") {
   const sentences = text.split(/[.!?؟،]+/).filter(chunk => chunk.trim().length > 0);
   
    return sentences.reduce((chunks, sentence) => {
      if (sentence.length > maxLength) {
        const words = sentence.split(/\s+/);
        let currentChunk = '';
        for (const word of words) {
          if ((currentChunk + ' ' + word).length <= maxLength) {
            currentChunk += (currentChunk ? ' ' : '') + word;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = word;
          }
        }
        if (currentChunk) chunks.push(currentChunk);
      } else {
        chunks.push(sentence);
      }
      return chunks;
    }, []);
  }
  return text.match(new RegExp(`.{1,${maxLength}}(\\s|$)`, "g")) || [];
}


function startSpeech(text) {
  chrome.storage.local.get(["speechSettings"], (result) => {
    if (result.speechSettings) {
      currentSettings = result.speechSettings;
      console.log('Using speech settings:', currentSettings);
    }

    chunks = splitText(text);
    chunkIndex = 0;
    isPaused = false;
    speakNextChunk();
  });
}

function speakNextChunk() {
  if (chunkIndex >= chunks.length) {
    try {
      chrome.runtime.sendMessage({ action: "speechEnded" });
    } catch {
      console.log("Popup not open, message not sent");
    }
    return;
  }
  chrome.tts.getVoices((voices) => {
    const matchingVoices = voices.filter(voice => 
      voice.lang.startsWith(currentSettings.lang)
    );

    let selectedVoice = currentSettings.voice;
    if (!selectedVoice || !matchingVoices.some(v => v.voiceName === selectedVoice)) {
      selectedVoice = matchingVoices.length > 0 ? matchingVoices[0].voiceName : '';
    }

    chrome.tts.speak(chunks[chunkIndex], {
      voiceName: selectedVoice,
      rate: currentSettings.rate,
      lang: currentSettings.lang,
      onEvent: (event) => {
        if (event.type === "end" && !isPaused) {
          chunkIndex++;
          speakNextChunk();
        } else if (event.type === "error") {
          console.error("TTS Error:", event.errorMessage);
          try {
            chrome.runtime.sendMessage({ 
              action: "speechError", 
              error: event.errorMessage 
            });
          } catch {
            console.log("Popup not open, error message not sent");
          }
        }
      },
    });
  });
}

function sendMessageToPopup(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    console.log("Popup not open, message not sent:", message);
  }
}
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  let delay = initialDelay;

  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries === maxRetries) {
        throw error;
      }
      console.log(`Retry attempt ${retries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) {
    throw new Error('Text and target language are required');
  }
  if (!/^[a-z]{2}$/.test(targetLang)) {
    throw new Error('Invalid target language format. Use two-letter language code (e.g., "es", "fr")');
  }

  try {
    console.log('Starting translation:', { text: text.substring(0, 50) + '...', targetLang });
    try {
      return await retryWithBackoff(async () => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        console.log('Making request to Google Translate API');
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          mode: 'cors'
        });
        
        if (!response.ok) {
          throw new Error(`Google Translate API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Google Translate response received');

        if (data && data[0] && data[0][0] && data[0][0][0]) {
          const translatedText = data[0].map(item => item[0]).join(' ');
          console.log('Successfully translated with Google Translate');
          await updateTranslationState(translatedText);
          return translatedText;
        }
        throw new Error('Invalid response from Google Translate');
      });
    } catch (googleError) {
      console.error('Google Translate failed:', googleError);
      console.log('Attempting MyMemory fallback...');
      return await translateWithMyMemory(text, targetLang);
    }
  } catch (error) {
    console.error("Translation error:", error);
    try {
      console.log('Attempting MyMemory fallback...');
      return await translateWithMyMemory(text, targetLang);
    } catch (myMemoryError) {
      console.error("MyMemory error:", myMemoryError);
      try {
        console.log('Attempting LibreTranslate fallback...');
        return await translateWithLibreTranslate(text, targetLang);
      } catch (libreError) {
        console.error("LibreTranslate error:", libreError);
        const errorMessage = 'All translation services are currently unavailable. Please try again later.';
        await updateTranslationError(errorMessage);
        throw new Error(errorMessage);
      }
    }
  }
}

async function translateWithMyMemory(text, targetLang) {
  try {
    return await retryWithBackoff(async () => {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
      console.log('Making request to MyMemory API');
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        mode: 'cors'
      });
      
      if (!response.ok) {
        throw new Error(`MyMemory API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('MyMemory response received');

      if (data.responseStatus === 200 && 
          data.responseData && 
          typeof data.responseData.translatedText === 'string' && 
          data.responseData.translatedText.trim() !== '') {
        const translatedText = data.responseData.translatedText;
        console.log('Successfully translated with MyMemory');
        await updateTranslationState(translatedText);
        return translatedText;
      }
      throw new Error('Invalid response from MyMemory');
    });
  } catch (error) {
    throw new Error('MyMemory service failed: ' + error.message);
  }
}

async function updateTranslationState(translatedText) {
  if (!translatedText || typeof translatedText !== 'string') {
    throw new Error('Invalid translation text');
  }

  await chrome.storage.local.set({ 
    translatedText: translatedText,
    translationNeeded: false,
    translationError: null 
  });
  
  sendMessageToPopup({
    action: "translationComplete",
    translatedText: translatedText
  });
}

async function updateTranslationError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    errorMessage = 'An unknown error occurred during translation';
  }

  await chrome.storage.local.set({ 
    translationError: errorMessage,
    translationNeeded: false,
    translatedText: null 
  });
  
  sendMessageToPopup({
    action: "translationError",
    error: errorMessage
  });
}
async function translateWithLibreTranslate(text, targetLang) {
  try {
    return await retryWithBackoff(async () => {
      const instances = [
        'https://libretranslate.de',
        'https://translate.argosopentech.com',
        'https://translate.terraprint.co'
      ];

      for (const baseUrl of instances) {
        try {
          const url = `${baseUrl}/translate`;
          console.log(`Trying LibreTranslate instance: ${baseUrl}`);
          
          const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({
              q: text,
              source: 'en',
              target: targetLang,
              format: 'text'
            }),
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            mode: 'cors'
          });

          if (!response.ok) {
            console.log(`LibreTranslate instance ${baseUrl} failed with status: ${response.status}`);
            continue;
          }

          const data = await response.json();
          
          if (data.translatedText) {
            console.log(`Successfully translated using ${baseUrl}`);
            await updateTranslationState(data.translatedText);
            return data.translatedText;
          }
        } catch (instanceError) {
          console.log(`Error with LibreTranslate instance ${baseUrl}:`, instanceError);
          continue;
        }
      }
      throw new Error('All LibreTranslate instances failed');
    });
  } catch (error) {
    console.error('All LibreTranslate instances failed:', error);
    throw new Error('LibreTranslate service unavailable');
  }
}

chrome.runtime.onMessage.addListener((request) => {
  let text, voice;
  
  switch (request.action) {
    case "pause":
      chrome.tts.pause();
      isPaused = true;
      break;
    case "resume":
      chrome.tts.resume();
      isPaused = false;
      break;
    case "stop":
      chrome.tts.stop();
      isPaused = false;
      chunks = [];
      chunkIndex = 0;
      break;
    case "translate":
      translateText(request.text, request.targetLang)
        .catch(error => {
          console.error('Translation error:', error);
          updateTranslationError(error.message);
        });
      break;
    case "readText":
      text = request.text;
      voice = request.voice;

      if (voice && voice.startsWith('ar-XA')) {
        const apiKey = 'YOUR_GOOGLE_CLOUD_API_KEY';
        const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;
        
        const data = {
          input: { text },
          voice: {
            languageCode: 'ar-XA',
            name: voice
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 1.0,
            pitch: 0.0
          }
        };

        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data)
        })
        .then(response => response.json())
        .then(data => {
          if (data.audioContent) {
            const audio = new Audio(`data:audio/mp3;base64,${data.audioContent}`);
            audio.play();
          }
        })
        .catch(error => {
          console.error('Error with Arabic TTS:', error);
          startSpeech(text);
        });
      } else {
        startSpeech(text);
      }
      break;
    case "updateSettings":

      if (request.settings) {
        currentSettings = request.settings;
        chrome.storage.local.set({ speechSettings: currentSettings });
        if (chunks.length > 0) {
          chrome.tts.stop();
          startSpeech(chunks.join(' '));
        }
      }
      break;
  }
});

function fallbackToBrowserTTS() {
  chrome.tts.speak(chunks[chunkIndex], {
    lang: currentSettings.lang,
    rate: currentSettings.rate,
    onEvent: (event) => {
      if (event.type === "end" && !isPaused) {
        chunkIndex++;
        speakNextChunk();
      } else if (event.type === "error") {
        console.error("TTS Error:", event.errorMessage);
        try {
          chrome.runtime.sendMessage({ 
            action: "speechError", 
            error: event.errorMessage 
          });
        } catch {
          console.log("Popup not open, error message not sent");
        }
      }
    },
  });
}
