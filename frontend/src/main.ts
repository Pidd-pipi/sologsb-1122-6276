import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { ensureSeedData, markDbVersion } from './utils/db';
import { MERGE_EVENT } from './utils/handover';
import { useFaceStore } from './stores/faceStore';
import { useJointStore } from './stores/jointStore';
import { useGradeStore } from './stores/gradeStore';

async function bootstrap() {
  // 先完成 IndexedDB 迁移与示范数据灌入，再挂载应用
  await ensureSeedData();
  markDbVersion();

  const pinia = createPinia();
  const app = createApp(App);
  app.use(pinia);
  app.use(router);
  app.use(ElementPlus, { locale: zhCn });
  app.mount('#app');

  // 离线交接合并完成后，各 store 内存数据统一从库重载，避免展示旧结论
  window.addEventListener(MERGE_EVENT, () => {
    void useFaceStore(pinia).load();
    void useJointStore(pinia).load();
    void useGradeStore(pinia).load();
  });
}

void bootstrap();
