import React, { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import {
  Alert,
  Animated,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import wordsSource from './words.json';

type Word = {
  id: string;
  word: string;
  pos: string;
  meaningZh: string;
  exampleEn: string;
  exampleZh: string;
};

type Progress = {
  familiarity: number;
  nextReview: number;
  correctStreak: number;
  mastered: boolean;
  correctDates: string[]; // 記錄答對的日期（不同天才算）
};

type DailyStats = Record<string, number>;
type Mode = 'card' | 'fill' | 'choice' | 'reorder';
type ClozeBlankStyle = 'fixed' | 'length';
type ClozeHint = 'zh' | 'firstLetter' | 'none';

const PRIMARY = '#5340e0';
const BG = '#f4f5f7';
const STORAGE_PROGRESS = 'srs-progress-v1';
const STORAGE_TARGET = 'daily-target-v1';
const STORAGE_DAILY = 'daily-stats-v1';
const STORAGE_WRONG = 'wrong-words-v1';
const REVIEW_STEPS = [1, 2, 4, 8, 16];
const Tab = createBottomTabNavigator();

const words = normalizeWords(wordsSource);

function normalizeWords(data: any[]): Word[] {
  const fallback: Word[] = [
    {
      id: 'sample-1',
      word: 'abandon',
      pos: 'v.',
      meaningZh: '放棄',
      exampleEn: 'He decided to abandon the old plan.',
      exampleZh: '他決定放棄舊計畫。',
    },
  ];
  if (!Array.isArray(data) || data.length === 0) return fallback;

  return data.map((item, idx) => ({
    id: String(item.id ?? item.word ?? idx),
    word: String(item.word ?? item.english ?? ''),
    pos: String(item.pos ?? item.partOfSpeech ?? ''),
    meaningZh: String(item.meaningZh ?? item.chinese ?? item.meaning ?? ''),
    exampleEn: String(item.exampleEn ?? item.example_en ?? item.example ?? ''),
    exampleZh: String(item.exampleZh ?? item.example_zh ?? ''),
  }));
}

function App() {
  const [progressMap, setProgressMap] = useState<Record<string, Progress>>({});
  const [dailyTarget, setDailyTarget] = useState(20);
  const [dailyStats, setDailyStats] = useState<DailyStats>({});
  const [wrongWords, setWrongWords] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, t, d, w] = await Promise.all([
        AsyncStorage.getItem(STORAGE_PROGRESS),
        AsyncStorage.getItem(STORAGE_TARGET),
        AsyncStorage.getItem(STORAGE_DAILY),
        AsyncStorage.getItem(STORAGE_WRONG),
      ]);
      if (p) setProgressMap(JSON.parse(p));
      if (t) setDailyTarget(Number(t));
      if (d) setDailyStats(JSON.parse(d));
      if (w) setWrongWords(JSON.parse(w));
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_PROGRESS, JSON.stringify(progressMap));
  }, [progressMap, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_TARGET, String(dailyTarget));
  }, [dailyTarget, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_DAILY, JSON.stringify(dailyStats));
  }, [dailyStats, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_WRONG, JSON.stringify(wrongWords));
  }, [wrongWords, loaded]);

  const context = {
    progressMap,
    setProgressMap,
    dailyTarget,
    setDailyTarget,
    dailyStats,
    setDailyStats,
    wrongWords,
    setWrongWords,
    loaded,
  };

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Tab.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: PRIMARY },
          headerTintColor: '#fff',
          tabBarActiveTintColor: PRIMARY,
          tabBarStyle: { height: 62, paddingBottom: 8 },
        }}
      >
        <Tab.Screen name="首頁">{() => <HomeScreen {...context} />}</Tab.Screen>
        <Tab.Screen name="學習">{() => <LearnScreen {...context} />}</Tab.Screen>
        <Tab.Screen name="錯題本">{() => <WrongWordsScreen {...context} />}</Tab.Screen>
        <Tab.Screen name="統計">{() => <StatsScreen {...context} />}</Tab.Screen>
        <Tab.Screen name="設定">{() => <SettingsScreen {...context} />}</Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}

function HomeScreen(props: any) {
  const due = getDueWords(words, props.progressMap).length;
  const today = todayKey();
  const done = props.dailyStats[today] ?? 0;
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>英文單字 SRS</Text>
        <Card>
          <Text style={styles.cardTitle}>今日進度</Text>
          <Text style={styles.big}>{done} / {props.dailyTarget}</Text>
        </Card>
        <Card>
          <Text style={styles.cardTitle}>待複習數量</Text>
          <Text style={styles.big}>{due}</Text>
        </Card>
        <Card>
          <Text style={styles.cardTitle}>開始學習</Text>
          <Text style={styles.sub}>切換到「學習」分頁即可開始今天的題目。</Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function LearnScreen(props: any) {
  const [mode, setMode] = useState<Mode>('card');
  const [queue, setQueue] = useState<Word[]>([]);
  const [index, setIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [revealAnswer, setRevealAnswer] = useState(false);
  const [input, setInput] = useState('');
  const [streak, setStreak] = useState(0);
  const [choices, setChoices] = useState<Word[]>([]);
  const [correctCount, setCorrectCount] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [shuffledWords, setShuffledWords] = useState<string[]>([]);
  const [clozeBlankStyle, setClozeBlankStyle] = useState<ClozeBlankStyle>('fixed');
  const [clozeHint, setClozeHint] = useState<ClozeHint>('zh');
  const flash = useMemo(() => new Animated.Value(0), []);

  useEffect(() => {
    setQueue(buildQueue(words, props.progressMap, props.dailyTarget, mode));
    setIndex(0);
    setShowBack(false);
    setRevealAnswer(false);
    setCorrectCount(0);
    setWrongCount(0);
  }, [props.dailyTarget, mode]); // 切換模式時重新生成隊列

  useEffect(() => {
    // 切換模式時，避免展示上一個模式的揭露狀態
    setRevealAnswer(false);
    setShowBack(false);
    setCorrectCount(0);
    setWrongCount(0);
    setStreak(0);
  }, [mode]);

  const current = queue[index];
  const progress = current ? props.progressMap[current.id] : undefined;
  const cloze = current ? makeClozePrompt(current.exampleEn, current.word, clozeBlankStyle) : null;

  useEffect(() => {
    if (!queue[index]) return;
    setChoices(buildChoices(queue[index], words));
  }, [index, queue]);

  useEffect(() => {
    if (!current) return;
    if (mode === 'reorder') {
      const wordArray = current.exampleEn.split(/\s+/).filter(Boolean);
      setShuffledWords(shuffle([...wordArray]));
      setSelectedWords([]);
    }
  }, [index, mode, current]);

  const animateResult = (ok: boolean) => {
    Animated.sequence([
      Animated.timing(flash, { toValue: ok ? 1 : -1, duration: 200, useNativeDriver: false }),
      Animated.timing(flash, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start();
    if (!ok) Vibration.vibrate(220);
  };

  const onAnswer = (ok: boolean) => {
    if (!current) return;
    if (revealAnswer && mode !== 'card') return; // 避免連點

    animateResult(ok);
    const nextMap = { ...props.progressMap };
    nextMap[current.id] = updateProgress(nextMap[current.id], ok);
    props.setProgressMap(nextMap);

    const date = todayKey();
    props.setDailyStats({
      ...props.dailyStats,
      [date]: (props.dailyStats[date] ?? 0) + 1,
    });

    setStreak((prev) => (ok ? prev + 1 : 0));

    // 更新答對/答錯統計
    if (ok) {
      setCorrectCount((prev) => prev + 1);
    } else {
      setWrongCount((prev) => prev + 1);
      // 記錄答錯的單字（只在填空/選擇題/重組模式）
      if (mode !== 'card' && !props.wrongWords.includes(current.id)) {
        props.setWrongWords([...props.wrongWords, current.id]);
      }
    }

    setInput('');
    setShowBack(false);

    if (mode === 'card') {
      setRevealAnswer(false);
      setIndex((v) => v + 1);
      return;
    }

    // 填空/選擇題/重組：顯示答案，等待用戶按「下一題」
    setRevealAnswer(true);
  };

  const onNext = () => {
    setRevealAnswer(false);
    setIndex((v) => v + 1);
  };

  const handleSpeak = async (word: string) => {
    try {
      setIsSpeaking(true);
      console.log('🔊 準備播放:', word);

      // 使用 Google Translate TTS API（免費）
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(word)}`;
      console.log('📡 載入音訊:', ttsUrl);

      // 網頁版使用 Web Speech API
      if (Platform.OS === 'web') {
        const synth = (window as any).speechSynthesis;
        if (synth) {
          const utterance = new (window as any).SpeechSynthesisUtterance(word);

          // 選擇最佳的英文語音（優先選擇 Google 或高品質語音）
          const voices = synth.getVoices();
          const preferredVoices = [
            'Google US English',
            'Google UK English Female',
            'Google UK English Male',
            'Samantha',
            'Alex',
            'Karen',
          ];

          let selectedVoice = null;
          for (const preferred of preferredVoices) {
            selectedVoice = voices.find((v: any) => v.name === preferred);
            if (selectedVoice) break;
          }

          // 如果沒找到偏好語音，就找任何英文語音
          if (!selectedVoice) {
            selectedVoice = voices.find((v: any) => v.lang.startsWith('en'));
          }

          if (selectedVoice) {
            utterance.voice = selectedVoice;
            console.log('🎤 使用語音:', selectedVoice.name);
          }

          utterance.lang = 'en-US';
          utterance.rate = 0.9; // 語速稍慢一點
          utterance.pitch = 1.0; // 音調
          utterance.onend = () => {
            console.log('✅ 播放完成:', word);
            setIsSpeaking(false);
          };
          utterance.onerror = (e: any) => {
            console.error('❌ 播放錯誤:', e);
            setIsSpeaking(false);
          };
          synth.speak(utterance);
          console.log('▶️ 開始播放 (Web Speech API)');
        } else {
          console.error('瀏覽器不支援語音合成');
          setIsSpeaking(false);
        }
      } else {
        // 原生平台使用 expo-av
        // 設定 Audio Session
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
        });

        // 創建 Audio.Sound
        const { sound } = await Audio.Sound.createAsync(
          { uri: ttsUrl },
          { shouldPlay: true, volume: 1.0 },
          (status) => {
            if (status.isLoaded && status.didJustFinish) {
              console.log('✅ 播放完成:', word);
              sound.unloadAsync();
              setIsSpeaking(false);
            }
          }
        );

        console.log('▶️ 開始播放 (Native)');

        // 保險起見，10秒後自動重置
        setTimeout(() => {
          sound.unloadAsync().catch(() => {});
          setIsSpeaking(false);
        }, 10000);
      }

    } catch (error) {
      console.error('❌ 發音錯誤:', error);
      setIsSpeaking(false);
    }
  };

  const bgColor = flash.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['#ffd8d8', '#ffffff', '#ddffeb'],
  });

  if (!current) {
    // 單字卡模式：顯示已瀏覽完所有單字
    if (mode === 'card') {
      return (
        <SafeAreaView style={styles.page}>
          <View style={styles.container}>
            <Text style={styles.title}>✅ 已瀏覽完所有單字</Text>
            <Card>
              <Text style={styles.sub}>已瀏覽所有待複習與新單字！</Text>
            </Card>
          </View>
        </SafeAreaView>
      );
    }

    // 填空/選擇題/重組模式：顯示統計
    return (
      <SafeAreaView style={styles.page}>
        <View style={styles.container}>
          <Text style={styles.title}>🎉 今日學習已完成</Text>
          <Card>
            <Text style={styles.cardTitle}>學習統計</Text>
            <Text style={[styles.sub, { color: '#14a44d', fontSize: 18, marginTop: 8 }]}>✓ 答對：{correctCount} 題</Text>
            <Text style={[styles.sub, { color: '#d73737', fontSize: 18 }]}>✗ 答錯：{wrongCount} 題</Text>
            <Text style={[styles.sub, { fontSize: 18, marginTop: 8 }]}>
              正確率：{correctCount + wrongCount > 0 ? Math.round((correctCount / (correctCount + wrongCount)) * 100) : 0}%
            </Text>
          </Card>
          <Text style={styles.sub}>已完成今日 {props.dailyTarget} 個單字，明天再來！</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.modeRow}>
          {(['card', 'fill', 'choice', 'reorder'] as Mode[]).map((m) => (
            <Pressable key={m} style={[styles.modeBtn, mode === m && styles.modeBtnActive]} onPress={() => setMode(m)}>
              <Text style={[styles.modeText, mode === m && { color: '#fff' }]}>
                {m === 'card' ? '單字卡' : m === 'fill' ? '填空' : m === 'choice' ? '選擇題' : '句子重組'}
              </Text>
            </Pressable>
          ))}
        </View>

        <Animated.View style={[styles.card, { backgroundColor: bgColor }]}>
          {/* 單字卡模式：一直顯示單字 */}
          {mode === 'card' && (
            <>
              <Text style={styles.word}>{current.word}</Text>
              <View style={styles.tag}><Text style={styles.tagText}>{current.pos || 'N/A'}</Text></View>
              <Pressable onPress={() => handleSpeak(current.word)} disabled={isSpeaking}>
                <Text style={[styles.speaker, isSpeaking && { opacity: 0.5 }]}>
                  {isSpeaking ? '🔊 播放中...' : '🔊 發音'}
                </Text>
              </Pressable>
              <Text style={styles.stars}>{renderStars(progress?.familiarity ?? 0)}</Text>
            </>
          )}

          {/* 填空/選擇題/重組模式：答題後才顯示答案 */}
          {(mode === 'fill' || mode === 'choice' || mode === 'reorder') && revealAnswer && (
            <>
              <Text style={styles.word}>{current.word}</Text>
              <View style={styles.tag}><Text style={styles.tagText}>{current.pos || 'N/A'}</Text></View>
              <Pressable onPress={() => handleSpeak(current.word)} disabled={isSpeaking}>
                <Text style={[styles.speaker, isSpeaking && { opacity: 0.5 }]}>
                  {isSpeaking ? '🔊 播放中...' : '🔊 發音'}
                </Text>
              </Pressable>
            </>
          )}

          {/* 翻面顯示中文和例句 */}
          {((mode === 'card' && showBack) || revealAnswer) && (
            <>
              <Text style={styles.meaning}>{current.meaningZh}</Text>
              <Text style={styles.example}>EN: {current.exampleEn || '-'}</Text>
              <Text style={styles.example}>ZH: {current.exampleZh || '-'}</Text>
            </>
          )}
        </Animated.View>

        {mode === 'card' && (
          <>
            {!showBack ? (
              <Pressable style={styles.primaryBtn} onPress={() => setShowBack(true)}>
                <Text style={styles.primaryText}>翻面看答案</Text>
              </Pressable>
            ) : (
              <View style={styles.answerRow}>
                <Pressable style={[styles.answerBtn, { backgroundColor: '#14a44d' }]} onPress={() => onAnswer(true)}>
                  <Text style={styles.answerText}>記得</Text>
                </Pressable>
                <Pressable style={[styles.answerBtn, { backgroundColor: '#d73737' }]} onPress={() => onAnswer(false)}>
                  <Text style={styles.answerText}>不記得</Text>
                </Pressable>
              </View>
            )}
            <View style={styles.navRow}>
              <Pressable
                style={[styles.navBtn, index === 0 && styles.navBtnDisabled]}
                onPress={() => { if (index > 0) { setIndex((v) => v - 1); setShowBack(false); } }}
                disabled={index === 0}
              >
                <Text style={styles.navText}>← 上一個</Text>
              </Pressable>
              <Pressable
                style={styles.navBtn}
                onPress={() => { setIndex((v) => v + 1); setShowBack(false); }}
              >
                <Text style={styles.navText}>下一個 →</Text>
              </Pressable>
            </View>
          </>
        )}

        {mode === 'fill' && (
          <>
            <Text style={styles.sub}>克漏字：請從選項中選出正確單字</Text>

            <View style={styles.fillMenuRow}>
              <View style={styles.fillMenuGroup}>
                <Text style={styles.fillMenuLabel}>空格樣式</Text>
                <View style={styles.fillMenuButtons}>
                  <Pressable
                    style={[styles.fillMenuBtn, clozeBlankStyle === 'fixed' && styles.fillMenuBtnActive]}
                    onPress={() => setClozeBlankStyle('fixed')}
                  >
                    <Text style={[styles.fillMenuBtnText, clozeBlankStyle === 'fixed' && styles.fillMenuBtnTextActive]}>
                      固定 _______
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.fillMenuBtn, clozeBlankStyle === 'length' && styles.fillMenuBtnActive]}
                    onPress={() => setClozeBlankStyle('length')}
                  >
                    <Text
                      style={[styles.fillMenuBtnText, clozeBlankStyle === 'length' && styles.fillMenuBtnTextActive]}
                    >
                      依字數
                    </Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.fillMenuGroup}>
                <Text style={styles.fillMenuLabel}>提示</Text>
                <View style={styles.fillMenuButtons}>
                  <Pressable
                    style={[styles.fillMenuBtn, clozeHint === 'zh' && styles.fillMenuBtnActive]}
                    onPress={() => setClozeHint('zh')}
                  >
                    <Text style={[styles.fillMenuBtnText, clozeHint === 'zh' && styles.fillMenuBtnTextActive]}>中文</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.fillMenuBtn, clozeHint === 'firstLetter' && styles.fillMenuBtnActive]}
                    onPress={() => setClozeHint('firstLetter')}
                  >
                    <Text
                      style={[
                        styles.fillMenuBtnText,
                        clozeHint === 'firstLetter' && styles.fillMenuBtnTextActive,
                      ]}
                    >
                      首字母
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.fillMenuBtn, clozeHint === 'none' && styles.fillMenuBtnActive]}
                    onPress={() => setClozeHint('none')}
                  >
                    <Text style={[styles.fillMenuBtnText, clozeHint === 'none' && styles.fillMenuBtnTextActive]}>無</Text>
                  </Pressable>
                </View>
              </View>
            </View>

            <View style={styles.clozeBox}>
              <Text style={styles.clozeSentence}>{cloze?.prompt ?? `I _______ the word.`}</Text>
              {clozeHint === 'zh' && <Text style={styles.clozeHint}>提示：{current.meaningZh}</Text>}
              {clozeHint === 'firstLetter' && (
                <Text style={styles.clozeHint}>提示：{current.word.slice(0, 1).toUpperCase()}…</Text>
              )}
            </View>

            {!revealAnswer && (
              <View style={{ width: '100%', gap: 10 }}>
                {choices.map((c) => (
                  <Pressable
                    key={c.id}
                    style={styles.choiceBtn}
                    onPress={() => onAnswer(c.word === current.word)}
                  >
                    <Text style={styles.choiceText}>{c.word}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {revealAnswer && (
              <Pressable style={styles.primaryBtn} onPress={onNext}>
                <Text style={styles.primaryText}>下一題 →</Text>
              </Pressable>
            )}
          </>
        )}

        {mode === 'choice' && (
          <View style={{ width: '100%', gap: 10 }}>
            <Text style={styles.sub}>請選出符合中文意思的英文：{current.meaningZh}</Text>
            {!revealAnswer && choices.map((c) => (
              <Pressable
                key={c.id}
                style={styles.choiceBtn}
                onPress={() => onAnswer(c.word === current.word)}
              >
                <Text style={styles.choiceText}>{c.word}</Text>
              </Pressable>
            ))}

            {revealAnswer && (
              <>
                <View style={styles.card}>
                  <Text style={[styles.sub, { marginBottom: 8, fontWeight: '700' }]}>選項翻譯：</Text>
                  {choices.map((c) => (
                    <View key={c.id} style={styles.choiceResultRow}>
                      <Text style={[styles.choiceResultText, c.word === current.word && { color: '#14a44d', fontWeight: '800' }]}>
                        {c.word === current.word ? '✓ ' : ''}{c.word}
                      </Text>
                      <Text style={styles.choiceResultMeaning}>
                        {c.meaningZh}
                      </Text>
                    </View>
                  ))}
                </View>
                <Pressable style={styles.primaryBtn} onPress={onNext}>
                  <Text style={styles.primaryText}>下一題 →</Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {mode === 'reorder' && (
          <View style={{ width: '100%', gap: 10 }}>
            <Text style={styles.sub}>請重組以下單字成正確的句子</Text>
            <Text style={styles.clozeHint}>提示（中文）：{current.exampleZh}</Text>

            {/* 已選擇的單字 */}
            <View style={styles.reorderSelectedBox}>
              <Text style={styles.reorderLabel}>你的答案：</Text>
              <View style={styles.reorderWordRow}>
                {selectedWords.length === 0 ? (
                  <Text style={styles.reorderPlaceholder}>請點選下方單字來組成句子</Text>
                ) : (
                  selectedWords.map((word, idx) => (
                    <Pressable
                      key={`selected-${idx}`}
                      style={styles.reorderSelectedWord}
                      onPress={() => {
                        if (revealAnswer) return;
                        // 移除已選單字，放回候選區
                        setSelectedWords(selectedWords.filter((_, i) => i !== idx));
                        setShuffledWords([...shuffledWords, word]);
                      }}
                    >
                      <Text style={styles.reorderSelectedWordText}>{word}</Text>
                    </Pressable>
                  ))
                )}
              </View>
            </View>

            {/* 候選單字 */}
            {!revealAnswer && (
              <View style={styles.reorderCandidateBox}>
                <Text style={styles.reorderLabel}>候選單字：</Text>
                <View style={styles.reorderWordRow}>
                  {shuffledWords.map((word, idx) => (
                    <Pressable
                      key={`shuffled-${idx}`}
                      style={styles.reorderCandidateWord}
                      onPress={() => {
                        setSelectedWords([...selectedWords, word]);
                        setShuffledWords(shuffledWords.filter((_, i) => i !== idx));
                      }}
                    >
                      <Text style={styles.reorderCandidateWordText}>{word}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {/* 檢查按鈕或下一題 */}
            {!revealAnswer && shuffledWords.length === 0 && (
              <Pressable
                style={styles.primaryBtn}
                onPress={() => {
                  const userAnswer = selectedWords.join(' ').toLowerCase().trim();
                  const correctAnswer = current.exampleEn.toLowerCase().trim();
                  onAnswer(userAnswer === correctAnswer);
                }}
              >
                <Text style={styles.primaryText}>檢查答案</Text>
              </Pressable>
            )}

            {revealAnswer && (
              <Pressable style={styles.primaryBtn} onPress={onNext}>
                <Text style={styles.primaryText}>下一題 →</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.statsRow}>
          <Text style={styles.sub}>連勝：{streak}</Text>
          <Text style={[styles.sub, { color: '#14a44d' }]}>✓ {correctCount}</Text>
          <Text style={[styles.sub, { color: '#d73737' }]}>✗ {wrongCount}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatsScreen(props: any) {
  const values = words.map((w) => props.progressMap[w.id]).filter(Boolean) as Progress[];
  const mastered = values.filter((v) => v.mastered).length;
  const learning = values.filter((v) => !v.mastered).length;
  const untouched = words.length - values.length;

  // 計算待複習數量
  const now = Date.now();
  const dueCount = values.filter((v) => v.nextReview <= now).length;

  // 計算連續學習天數
  const days = buildRecentDays(365);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (props.dailyStats[days[i]]) {
      streak++;
    } else {
      break;
    }
  }

  // 計算本週統計（最近 7 天）
  const recent7Days = buildRecentDays(7);
  let weekTotal = 0;
  recent7Days.forEach((d) => {
    weekTotal += props.dailyStats[d] ?? 0;
  });

  // 計算今日統計（注意：這裡的 dailyStats 記錄的是答題數，不區分對錯）
  const today = todayKey();
  const todayCount = props.dailyStats[today] ?? 0;

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>學習統計</Text>

        <Card>
          <Text style={styles.cardTitle}>📊 學習進度</Text>
          <Text style={styles.sub}>已掌握：{mastered} 個</Text>
          <Text style={styles.sub}>學習中：{learning} 個</Text>
          <Text style={styles.sub}>未學習：{untouched} 個</Text>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>⚠️ 待複習</Text>
          <Text style={[styles.big, { color: dueCount > 0 ? '#d73737' : '#14a44d' }]}>{dueCount}</Text>
          <Text style={styles.sub}>{dueCount > 0 ? '快去複習吧！' : '目前沒有到期的單字'}</Text>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>🔥 連續學習</Text>
          <Text style={styles.big}>{streak} 天</Text>
          <Text style={styles.sub}>{streak > 0 ? '繼續保持！' : '今天開始學習吧'}</Text>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>📝 本週學習</Text>
          <Text style={styles.sub}>已完成：{weekTotal} 題</Text>
          <Text style={styles.sub}>平均每天：{(weekTotal / 7).toFixed(1)} 題</Text>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>📋 錯題本</Text>
          <Text style={styles.big}>{props.wrongWords.length}</Text>
          <Text style={styles.sub}>{props.wrongWords.length > 0 ? '記得去複習！' : '目前沒有錯題'}</Text>
        </Card>

        <Card>
          <Text style={styles.cardTitle}>學習日曆（近 14 天）</Text>
          <View style={styles.calendarRow}>
            {buildRecentDays(14).map((d) => {
              const count = props.dailyStats[d] ?? 0;
              return (
                <View key={d} style={[styles.dayCell, { backgroundColor: count ? '#9dd9b3' : '#e6e7ea' }]}>
                  <Text style={styles.dayText}>{d.slice(5)}</Text>
                  <Text style={{ fontSize: 10, color: '#2f3036' }}>{count || ''}</Text>
                </View>
              );
            })}
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function WrongWordsScreen(props: any) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [choices, setChoices] = useState<Word[]>([]);
  const [revealAnswer, setRevealAnswer] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const flash = useMemo(() => new Animated.Value(0), []);

  const wrongWordsList = useMemo(() => {
    return props.wrongWords
      .map((id: string) => words.find((w) => w.id === id))
      .filter(Boolean) as Word[];
  }, [props.wrongWords]);

  const current = wrongWordsList[currentIndex];

  useEffect(() => {
    if (!current) return;
    setChoices(buildChoices(current, words));
  }, [currentIndex, current]);

  const clearWrongWords = () => {
    Alert.alert(
      '清空錯題本',
      '確定要清空所有錯題嗎？',
      [
        { text: '取消', style: 'cancel' },
        { text: '確定', style: 'destructive', onPress: () => props.setWrongWords([]) },
      ]
    );
  };

  const removeWord = (id: string) => {
    props.setWrongWords(props.wrongWords.filter((wid: string) => wid !== id));
  };

  const handleSpeak = async (word: string) => {
    try {
      setIsSpeaking(true);

      // 網頁版使用 Web Speech API
      if (Platform.OS === 'web') {
        const synth = (window as any).speechSynthesis;
        if (synth) {
          const utterance = new (window as any).SpeechSynthesisUtterance(word);

          // 選擇最佳的英文語音
          const voices = synth.getVoices();
          const preferredVoices = [
            'Google US English',
            'Google UK English Female',
            'Google UK English Male',
            'Samantha',
            'Alex',
            'Karen',
          ];

          let selectedVoice = null;
          for (const preferred of preferredVoices) {
            selectedVoice = voices.find((v: any) => v.name === preferred);
            if (selectedVoice) break;
          }

          if (!selectedVoice) {
            selectedVoice = voices.find((v: any) => v.lang.startsWith('en'));
          }

          if (selectedVoice) {
            utterance.voice = selectedVoice;
          }

          utterance.lang = 'en-US';
          utterance.rate = 0.9;
          utterance.pitch = 1.0;
          utterance.onend = () => {
            setIsSpeaking(false);
          };
          utterance.onerror = (e: any) => {
            console.error('發音錯誤:', e);
            setIsSpeaking(false);
          };
          synth.speak(utterance);
        } else {
          console.error('瀏覽器不支援語音合成');
          setIsSpeaking(false);
        }
      } else {
        // 原生平台使用 expo-av
        // 設定 Audio Session
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
        });

        const { sound } = await Audio.Sound.createAsync(
          { uri: ttsUrl },
          { shouldPlay: true, volume: 1.0 },
          (status) => {
            if (status.isLoaded && status.didJustFinish) {
              sound.unloadAsync();
              setIsSpeaking(false);
            }
          }
        );

        setTimeout(() => {
          sound.unloadAsync().catch(() => {});
          setIsSpeaking(false);
        }, 10000);
      }

    } catch (error) {
      console.error('發音錯誤:', error);
      setIsSpeaking(false);
    }
  };

  const animateResult = (ok: boolean) => {
    Animated.sequence([
      Animated.timing(flash, { toValue: ok ? 1 : -1, duration: 200, useNativeDriver: false }),
      Animated.timing(flash, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start();
    if (!ok) Vibration.vibrate(220);
  };

  const onAnswer = (ok: boolean) => {
    if (!current || revealAnswer) return;

    animateResult(ok);

    if (ok) {
      // 答對：從錯題本移除
      removeWord(current.id);
      setCorrectCount((prev) => prev + 1);
      // 不顯示答案，直接下一題
      setTimeout(() => {
        setRevealAnswer(false);
        setCurrentIndex(0); // 重置到第一題（因為列表已更新）
      }, 400);
    } else {
      // 答錯：顯示答案
      setRevealAnswer(true);
    }
  };

  const onNext = () => {
    setRevealAnswer(false);
    if (currentIndex < wrongWordsList.length - 1) {
      setCurrentIndex((prev) => prev + 1);
    } else {
      setCurrentIndex(0);
    }
  };

  const startTest = () => {
    setTestMode(true);
    setCurrentIndex(0);
    setRevealAnswer(false);
    setCorrectCount(0);
  };

  const exitTest = () => {
    setTestMode(false);
    setCurrentIndex(0);
    setRevealAnswer(false);
  };

  const bgColor = flash.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['#ffd8d8', '#ffffff', '#ddffeb'],
  });

  // 查看模式
  if (!testMode) {
    return (
      <SafeAreaView style={styles.page}>
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.title}>錯題本</Text>
          <Card>
            <Text style={styles.cardTitle}>共 {wrongWordsList.length} 個錯題</Text>
            {wrongWordsList.length > 0 && (
              <View style={{ gap: 10, marginTop: 10 }}>
                <Pressable style={[styles.primaryBtn, { backgroundColor: PRIMARY }]} onPress={startTest}>
                  <Text style={styles.primaryText}>📝 開始測驗</Text>
                </Pressable>
                <Pressable style={[styles.primaryBtn, { backgroundColor: '#d73737' }]} onPress={clearWrongWords}>
                  <Text style={styles.primaryText}>清空錯題本</Text>
                </Pressable>
              </View>
            )}
          </Card>

          {wrongWordsList.length === 0 ? (
            <Card>
              <Text style={styles.sub}>目前沒有錯題，繼續加油！ 💪</Text>
            </Card>
          ) : (
            wrongWordsList.map((word) => (
              <Card key={word.id}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.word}>{word.word}</Text>
                    <View style={styles.tag}>
                      <Text style={styles.tagText}>{word.pos || 'N/A'}</Text>
                    </View>
                    <Text style={styles.meaning}>{word.meaningZh}</Text>
                    <Text style={styles.example}>EN: {word.exampleEn || '-'}</Text>
                    <Text style={styles.example}>ZH: {word.exampleZh || '-'}</Text>
                  </View>
                  <Pressable onPress={() => removeWord(word.id)} style={{ padding: 8 }}>
                    <Text style={{ fontSize: 24, color: '#d73737' }}>✗</Text>
                  </Pressable>
                </View>
                <Pressable onPress={() => handleSpeak(word.word)} disabled={isSpeaking} style={{ marginTop: 8 }}>
                  <Text style={[styles.speaker, isSpeaking && { opacity: 0.5 }]}>
                    {isSpeaking ? '🔊 播放中...' : '🔊 發音'}
                  </Text>
                </Pressable>
              </Card>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // 測驗模式
  if (!current) {
    return (
      <SafeAreaView style={styles.page}>
        <View style={styles.container}>
          <Text style={styles.title}>🎉 錯題已全部答對！</Text>
          <Card>
            <Text style={styles.cardTitle}>測驗完成</Text>
            <Text style={[styles.sub, { fontSize: 18, marginTop: 8 }]}>本次答對：{correctCount} 題</Text>
          </Card>
          <Pressable style={styles.primaryBtn} onPress={exitTest}>
            <Text style={styles.primaryText}>返回錯題本</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.sub}>錯題測驗 ({currentIndex + 1}/{wrongWordsList.length})</Text>
          <Pressable onPress={exitTest}>
            <Text style={{ color: PRIMARY, fontWeight: '700' }}>結束測驗</Text>
          </Pressable>
        </View>

        <Animated.View style={[styles.card, { backgroundColor: bgColor }]}>
          {revealAnswer && (
            <>
              <Text style={styles.word}>{current.word}</Text>
              <View style={styles.tag}>
                <Text style={styles.tagText}>{current.pos || 'N/A'}</Text>
              </View>
              <Pressable onPress={() => handleSpeak(current.word)} disabled={isSpeaking}>
                <Text style={[styles.speaker, isSpeaking && { opacity: 0.5 }]}>
                  {isSpeaking ? '🔊 播放中...' : '🔊 發音'}
                </Text>
              </Pressable>
              <Text style={styles.meaning}>{current.meaningZh}</Text>
              <Text style={styles.example}>EN: {current.exampleEn || '-'}</Text>
              <Text style={styles.example}>ZH: {current.exampleZh || '-'}</Text>
            </>
          )}
        </Animated.View>

        <View style={{ width: '100%', gap: 10 }}>
          <Text style={styles.sub}>請選出符合中文意思的英文：{current.meaningZh}</Text>
          {!revealAnswer && choices.map((c) => (
            <Pressable key={c.id} style={styles.choiceBtn} onPress={() => onAnswer(c.word === current.word)}>
              <Text style={styles.choiceText}>{c.word}</Text>
            </Pressable>
          ))}

          {revealAnswer && (
            <>
              <View style={styles.card}>
                <Text style={[styles.sub, { marginBottom: 8, fontWeight: '700' }]}>選項翻譯：</Text>
                {choices.map((c) => (
                  <View key={c.id} style={styles.choiceResultRow}>
                    <Text style={[styles.choiceResultText, c.word === current.word && { color: '#14a44d', fontWeight: '800' }]}>
                      {c.word === current.word ? '✓ ' : ''}{c.word}
                    </Text>
                    <Text style={styles.choiceResultMeaning}>{c.meaningZh}</Text>
                  </View>
                ))}
              </View>
              <Pressable style={styles.primaryBtn} onPress={onNext}>
                <Text style={styles.primaryText}>下一題 →</Text>
              </Pressable>
            </>
          )}
        </View>

        <Text style={styles.sub}>本次已答對：{correctCount} 題</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingsScreen(props: any) {
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <Text style={styles.cardTitle}>每日目標單字數</Text>
          <View style={styles.answerRow}>
            <Pressable style={styles.adjustBtn} onPress={() => props.setDailyTarget(Math.max(5, props.dailyTarget - 5))}>
              <Text style={styles.answerText}>-5</Text>
            </Pressable>
            <Text style={styles.big}>{props.dailyTarget}</Text>
            <Pressable style={styles.adjustBtn} onPress={() => props.setDailyTarget(props.dailyTarget + 5)}>
              <Text style={styles.answerText}>+5</Text>
            </Pressable>
          </View>
        </Card>
        <Card>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: '#d73737' }]}
            onPress={() => {
              props.setProgressMap({});
              props.setDailyStats({});
            }}
          >
            <Text style={styles.primaryText}>重置進度</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function updateProgress(old: Progress | undefined, correct: boolean): Progress {
  const base: Progress = old ?? {
    familiarity: 0,
    nextReview: Date.now(),
    correctStreak: 0,
    mastered: false,
    correctDates: []
  };

  // 確保舊資料也有 correctDates（向下相容）
  const existingDates = base.correctDates ?? [];

  const today = todayKey();

  if (!correct) {
    // 答錯：清空所有記錄，24小時後再來
    return {
      familiarity: 0,
      correctStreak: 0,
      nextReview: Date.now() + 24 * 60 * 60 * 1000,
      mastered: false,
      correctDates: [], // 清空！一錯就重來
    };
  }

  // 答對：記錄今天的日期（如果今天還沒記錄過）
  const newCorrectDates = existingDates.includes(today)
    ? existingDates
    : [...existingDates, today];

  const streak = base.correctStreak + 1;

  // 判斷是否掌握：在不同天連續答對 >= 3 次（中間不能錯）
  const uniqueDaysCorrect = newCorrectDates.length;
  if (uniqueDaysCorrect >= 3) {
    return {
      familiarity: 5,
      correctStreak: streak,
      mastered: true,
      nextReview: Date.now() + 30 * 24 * 60 * 60 * 1000,
      correctDates: newCorrectDates,
    };
  }

  // 未掌握：繼續複習
  const interval = REVIEW_STEPS[Math.min(streak - 1, REVIEW_STEPS.length - 1)];
  return {
    familiarity: Math.min(5, base.familiarity + 1),
    correctStreak: streak,
    mastered: false,
    nextReview: Date.now() + interval * 24 * 60 * 60 * 1000,
    correctDates: newCorrectDates,
  };
}

function buildQueue(allWords: Word[], progressMap: Record<string, Progress>, dailyTarget: number, mode: Mode): Word[] {
  // 先拿出今天到期的單字並隨機排列，再接上新單字（兩段都隨機）
  const due = shuffle(getDueWords(allWords, progressMap));
  const untouched = shuffle(allWords.filter((w) => !progressMap[w.id]));
  const combined = [...due, ...untouched];

  // 單字卡模式：不限制數量（可以無限瀏覽）
  if (mode === 'card') {
    return combined;
  }

  // 填空/選擇題/重組模式：限制題目數量為每日目標
  return combined.slice(0, dailyTarget);
}

function getDueWords(allWords: Word[], progressMap: Record<string, Progress>) {
  const now = Date.now();
  return allWords.filter((w) => {
    const p = progressMap[w.id];
    return p && p.nextReview <= now;
  });
}

function buildChoices(target: Word, allWords: Word[]) {
  const pool = allWords.filter((w) => w.id !== target.id);
  const picks = shuffle(pool).slice(0, 3);
  return shuffle([target, ...picks]);
}

function makeClozePrompt(exampleEn: string, targetWord: string, style: ClozeBlankStyle) {
  const sentence = String(exampleEn ?? '').trim();
  const target = String(targetWord ?? '').trim();
  if (!sentence || !target) return null;

  const blank = style === 'length' ? '_'.repeat(Math.max(5, target.length)) : '_______';
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 方法1：嘗試完全匹配（原本的邏輯）
  const exactRe = new RegExp(`\\b${escaped}\\b`, 'gi');
  let replaced = sentence.replace(exactRe, blank);

  if (replaced !== sentence) {
    return { prompt: replaced };
  }

  // 方法2：嘗試詞形變化匹配（如 sacrifice → sacrifices, able → ability）
  // 匹配以目標單字開頭的單字（至少3個字母）
  if (target.length >= 3) {
    const stemRe = new RegExp(`\\b${escaped}[a-z]*\\b`, 'gi');
    replaced = sentence.replace(stemRe, blank);

    if (replaced !== sentence) {
      return { prompt: replaced };
    }
  }

  // 方法3：嘗試反向匹配（如 acceptable → accept）
  // 尋找包含目標單字的較長單字
  const words = sentence.match(/\b[a-z]+\b/gi) || [];
  for (const word of words) {
    if (word.toLowerCase().includes(target.toLowerCase()) && word.length > target.length) {
      const wordEscaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reverseRe = new RegExp(`\\b${wordEscaped}\\b`, 'gi');
      replaced = sentence.replace(reverseRe, blank);
      return { prompt: replaced };
    }
  }

  // 若都找不到，改用通用句型
  return { prompt: `I ${blank} the word.` };
}

function shuffle<T>(arr: T[]) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function buildRecentDays(days: number) {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function renderStars(level: number) {
  return `熟悉度 ${'★'.repeat(level)}${'☆'.repeat(5 - level)}`;
}

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: BG },
  container: { padding: 16, gap: 12 },
  title: { fontSize: 28, fontWeight: '800', color: PRIMARY, marginBottom: 6 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#2b2c32' },
  big: { fontSize: 34, fontWeight: '800', color: PRIMARY },
  sub: { fontSize: 16, color: '#4c4d55' },
  word: { fontSize: 36, fontWeight: '800', color: '#1f2331' },
  tag: { alignSelf: 'flex-start', backgroundColor: '#edeaff', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { color: PRIMARY, fontWeight: '700' },
  speaker: { color: PRIMARY, fontWeight: '700' },
  stars: { color: '#f2a900', fontSize: 16, fontWeight: '700' },
  meaning: { fontSize: 24, fontWeight: '700', color: '#34353d' },
  example: { color: '#4f5058', lineHeight: 22 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 10, padding: 10 },
  modeBtnActive: { backgroundColor: PRIMARY },
  modeText: { textAlign: 'center', color: '#4f4f5a', fontWeight: '700' },
  primaryBtn: { backgroundColor: PRIMARY, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  answerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  answerBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  answerText: { color: '#fff', fontWeight: '800' },
  input: { backgroundColor: '#fff', borderRadius: 12, padding: 12, fontSize: 17 },
  choiceBtn: { backgroundColor: '#fff', borderRadius: 12, padding: 12 },
  choiceText: { fontSize: 17, color: '#34353d', fontWeight: '700' },
  fillMenuRow: { width: '100%', gap: 10 },
  fillMenuGroup: { gap: 6 },
  fillMenuLabel: { fontSize: 13, color: '#6a6b73', fontWeight: '700' },
  fillMenuButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fillMenuBtn: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  fillMenuBtnActive: { backgroundColor: PRIMARY },
  fillMenuBtnText: { color: '#4f5058', fontWeight: '800' },
  fillMenuBtnTextActive: { color: '#fff' },
  clozeBox: { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 8 },
  clozeSentence: { fontSize: 17, color: '#2f3036', fontWeight: '700', lineHeight: 24 },
  clozeHint: { fontSize: 15, color: '#4c4d55' },
  calendarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dayCell: { width: 52, height: 38, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  dayText: { fontSize: 12, color: '#2f3036' },
  adjustBtn: { backgroundColor: PRIMARY, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10 },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 4 },
  navBtn: { flex: 1, backgroundColor: '#e0e1e8', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  navBtnDisabled: { opacity: 0.35 },
  navText: { color: '#2b2c32', fontWeight: '700', fontSize: 15 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginTop: 8 },
  choiceResultRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  choiceResultText: { fontSize: 16, color: '#34353d', fontWeight: '700', flex: 1 },
  choiceResultMeaning: { fontSize: 14, color: '#6a6b73', flex: 1, textAlign: 'right' },
  reorderSelectedBox: { backgroundColor: '#fff', borderRadius: 16, padding: 14, gap: 8 },
  reorderCandidateBox: { backgroundColor: '#f8f8f9', borderRadius: 16, padding: 14, gap: 8 },
  reorderLabel: { fontSize: 14, color: '#4c4d55', fontWeight: '700' },
  reorderWordRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, minHeight: 40 },
  reorderSelectedWord: { backgroundColor: PRIMARY, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  reorderSelectedWordText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  reorderCandidateWord: { backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#e0e1e8' },
  reorderCandidateWordText: { color: '#34353d', fontSize: 15, fontWeight: '700' },
  reorderPlaceholder: { fontSize: 14, color: '#9a9ba3', fontStyle: 'italic' },
});

export default App;
