<script setup lang="ts">
import { h, watch } from 'vue';
import { ref, onMounted, computed } from 'vue';
import { NCard, NButton, NDataTable, NSpace, NSwitch, useMessage, NModal, NForm, NFormItem, NInput, NSelect, NInputNumber } from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules } from 'naive-ui';
import { api } from '@/utils/api';

const props = defineProps<{
  profileId?: string | null;
  modelValue: any[];
}>();

const emit = defineEmits(['update:modelValue']);

const message = useMessage();
const rules = ref<any[]>([]);
const loading = ref(false);
const showModal = ref(false);
const isEditing = ref(false);
const formRef = ref<FormInst | null>(null);
const currentRule = ref<any>(null);
const editingIndex = ref(-1);

const isLocalMode = computed(() => !props.profileId);

watch(() => props.modelValue, (newValue) => {
  if (isLocalMode.value) {
    rules.value = JSON.parse(JSON.stringify(newValue));
  }
}, { deep: true, immediate: true });


const ruleTypes = [
  { label: '按名称关键字过滤', value: 'filter_by_name_keyword' },
  { label: '按名称正则表达式过滤', value: 'filter_by_name_regex' },
  { label: '按名称关键字排除', value: 'exclude_by_name_keyword' },
  { label: '按正则表达式重命名', value: 'rename_by_regex' },
];

const formRules: FormRules = {
  name: { required: true, message: '请输入规则名称', trigger: 'blur' },
  type: { required: true, message: '请选择规则类型', trigger: 'change' },
  value: { required: true, message: '请输入规则值', trigger: 'blur' },
};

const fetchRules = async () => {
  if (isLocalMode.value || !props.profileId) return;
  loading.value = true;
  try {
    const response = await api.get(`/profile-rules/${props.profileId}`);
    if (response.data.success) {
      rules.value = response.data.data;
      emit('update:modelValue', JSON.parse(JSON.stringify(rules.value)));
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
  currentRule.value = {
    // For local mode, we use a temporary ID for editing purposes
    id: isLocalMode.value ? `temp_${Date.now()}` : undefined,
    name: '',
    type: null,
    value: '',
    enabled: 1,
    sort_order: rules.value.length,
    profile_id: props.profileId
  };
  showModal.value = true;
};

const handleEdit = (rule: any, index: number) => {
  isEditing.value = true;
  editingIndex.value = index;
  currentRule.value = { ...rule };
  showModal.value = true;
};

const handleDelete = async (ruleOrId: any, index: number) => {
  if (isLocalMode.value) {
    rules.value.splice(index, 1);
    emit('update:modelValue', JSON.parse(JSON.stringify(rules.value)));
    message.success('规则已删除');
  } else {
    try {
      await api.delete(`/profile-rules/${ruleOrId.id}`);
      message.success('规则删除成功');
      fetchRules();
    } catch (error) {
      message.error('删除规则失败');
    }
  }
};

const handleSave = async () => {
  formRef.value?.validate(async (errors) => {
    if (errors) {
      message.error('请填写所有必填项');
      return;
    }
    if (!currentRule.value) return;

    if (isLocalMode.value) {
      if (isEditing.value) {
        rules.value[editingIndex.value] = currentRule.value;
      } else {
        rules.value.push(currentRule.value);
      }
      emit('update:modelValue', JSON.parse(JSON.stringify(rules.value)));
      showModal.value = false;
      message.success('规则已保存');
    } else {
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
    }
  });
};

const handleEnabledChange = async (rule: any, enabled: boolean) => {
  rule.enabled = enabled ? 1 : 0;
  if (isLocalMode.value) {
    emit('update:modelValue', JSON.parse(JSON.stringify(rules.value)));
    message.success('状态已更新');
  } else {
    try {
      await api.put(`/profile-rules/${rule.id}`, { ...rule, enabled: rule.enabled });
      message.success('状态更新成功');
    } catch (error) {
      message.error('更新状态失败');
      rule.enabled = !enabled ? 1 : 0; // Revert on failure
    }
  }
};

const columns = computed<DataTableColumns<any>>(() => [
  { title: '名称', key: 'name' },
  { title: '类型', key: 'type', render: (row) => ruleTypes.find(t => t.value === row.type)?.label || row.type },
  { title: '值', key: 'value', ellipsis: { tooltip: true } },
  { title: '排序', key: 'sort_order', width: 80, align: 'center' },
  {
    title: '启用',
    key: 'enabled',
    width: 80,
    align: 'center',
    render: (row) => h(NSwitch, {
      value: row.enabled === 1,
      onUpdateValue: (v: boolean) => handleEnabledChange(row, v),
    }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    align: 'center',
    render: (row, index) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => handleEdit(row, index) }, { default: () => '编辑' }),
        h(NButton, { size: 'small', type: 'error', onClick: () => handleDelete(row, index) }, { default: () => '删除' }),
      ],
    }),
  },
]);

onMounted(() => {
  if (!isLocalMode.value) {
    fetchRules();
  }
});
</script>

<template>
  <n-card title="Profile 最终处理规则" :bordered="false" size="small">
    <template #header-extra>
      <n-button @click="handleAdd">添加规则</n-button>
    </template>
    <n-data-table :columns="columns" :data="rules" :loading="loading" :pagination="false" :bordered="false" />
  </n-card>

  <n-modal v-model:show="showModal" preset="card" :title="isEditing ? '编辑规则' : '添加规则'" style="width: 600px;">
    <n-form ref="formRef" :model="currentRule" :rules="formRules">
      <n-form-item label="规则名称" path="name">
        <n-input v-model:value="currentRule.name" />
      </n-form-item>
      <n-form-item label="规则类型" path="type">
        <n-select v-model:value="currentRule.type" :options="ruleTypes" />
      </n-form-item>
      <n-form-item label="规则值" path="value">
        <n-input v-model:value="currentRule.value" type="textarea" :autosize="{ minRows: 3 }" />
      </n-form-item>
      <n-form-item label="排序" path="sort_order">
        <n-input-number v-model:value="currentRule.sort_order" />
      </n-form-item>
      <n-space justify="end">
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" @click="handleSave">保存</n-button>
      </n-space>
    </n-form>
  </n-modal>
</template>