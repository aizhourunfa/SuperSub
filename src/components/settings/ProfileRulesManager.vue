<script setup lang="ts">
import { h } from 'vue';
import { ref, onMounted, computed } from 'vue';
import { NCard, NButton, NDataTable, NSpace, NSwitch, useMessage, NModal, NForm, NFormItem, NInput, NSelect } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { api } from '@/utils/api';

const props = defineProps<{
  profileId: string;
}>();

const message = useMessage();
const rules = ref<any[]>([]);
const loading = ref(false);
const showModal = ref(false);
const isEditing = ref(false);
const currentRule = ref<any>(null);

const ruleTypes = [
  { label: '按名称关键字过滤', value: 'filter_by_name_keyword' },
  { label: '按名称正则表达式过滤', value: 'filter_by_name_regex' },
  { label: '按名称关键字排除', value: 'exclude_by_name_keyword' },
  { label: '按正则表达式重命名', value: 'rename_by_regex' },
];

const fetchRules = async () => {
  if (!props.profileId) return;
  loading.value = true;
  try {
    const response = await api.get(`/profile-rules/${props.profileId}`);
    if (response.data.success) {
      rules.value = response.data.data;
    } else {
      message.error('获取规则失败');
    }
  } catch (error) {
    message.error('请求规则列表失败');
  } finally {
    loading.value = false;
  }
};

const handleAdd = () => {
  isEditing.value = false;
  currentRule.value = { name: '', type: null, value: '', enabled: 1, sort_order: 0, profile_id: props.profileId };
  showModal.value = true;
};

const handleEdit = (rule: any) => {
  isEditing.value = true;
  currentRule.value = { ...rule };
  showModal.value = true;
};

const handleDelete = async (id: number) => {
  try {
    await api.delete(`/profile-rules/${id}`);
    message.success('规则删除成功');
    fetchRules();
  } catch (error) {
    message.error('删除规则失败');
  }
};

const handleSave = async () => {
  if (!currentRule.value) return;
  try {
    if (isEditing.value) {
      await api.put(`/profile-rules/${currentRule.value.id}`, currentRule.value);
      message.success('规则更新成功');
    } else {
      await api.post('/profile-rules', currentRule.value);
      message.success('规则添加成功');
    }
    showModal.value = false;
    fetchRules();
  } catch (error) {
    message.error('保存规则失败');
  }
};

const handleEnabledChange = async (rule: any, enabled: boolean) => {
  try {
    await api.put(`/profile-rules/${rule.id}`, { ...rule, enabled: enabled ? 1 : 0 });
    message.success('状态更新成功');
    rule.enabled = enabled ? 1 : 0;
  } catch (error) {
    message.error('更新状态失败');
    // Revert the switch on failure
    rule.enabled = !enabled;
  }
};

const columns = computed<DataTableColumns<any>>(() => [
  { title: '名称', key: 'name' },
  { title: '类型', key: 'type', render: (row) => ruleTypes.find(t => t.value === row.type)?.label || row.type },
  { title: '值', key: 'value' },
  { title: '排序', key: 'sort_order' },
  {
    title: '启用',
    key: 'enabled',
    render: (row) => h(NSwitch, {
      value: row.enabled === 1,
      onUpdateValue: (v: boolean) => handleEnabledChange(row, v),
    }),
  },
  {
    title: '操作',
    key: 'actions',
    render: (row) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => handleEdit(row) }, { default: () => '编辑' }),
        h(NButton, { size: 'small', type: 'error', onClick: () => handleDelete(row.id) }, { default: () => '删除' }),
      ],
    }),
  },
]);

onMounted(fetchRules);
</script>

<template>
  <n-card title="Profile 最终处理规则" :bordered="false" size="small">
    <template #header-extra>
      <n-button @click="handleAdd">添加规则</n-button>
    </template>
    <n-data-table :columns="columns" :data="rules" :loading="loading" :pagination="false" :bordered="false" />
  </n-card>

  <n-modal v-model:show="showModal" preset="card" :title="isEditing ? '编辑规则' : '添加规则'" style="width: 600px;">
    <n-form :model="currentRule">
      <n-form-item label="规则名称">
        <n-input v-model:value="currentRule.name" />
      </n-form-item>
      <n-form-item label="规则类型">
        <n-select v-model:value="currentRule.type" :options="ruleTypes" />
      </n-form-item>
      <n-form-item label="规则值">
        <n-input v-model:value="currentRule.value" type="textarea" :autosize="{ minRows: 3 }" />
      </n-form-item>
      <n-form-item label="排序">
        <n-input-number v-model:value="currentRule.sort_order" />
      </n-form-item>
      <n-space justify="end">
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" @click="handleSave">保存</n-button>
      </n-space>
    </n-form>
  </n-modal>
</template>