package org.shufang.android

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import org.junit.Rule
import org.junit.Test

class LibraryUiTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun offlineNavigationAndNativeNoteEditing() {
        check(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.getSharedPreferences("android-ui",0).getString("origin",null).isNullOrBlank()){ "UI write tests require an isolated offline library" }
        // Own the scenario explicitly, as the other touch tests do. MuMu replaces
        // virtual displays across tests; a rule-owned activity can await frames
        // from a removed display before even reaching the first assertion.
        val scenario=ActivityScenario.launch(MainActivity::class.java)
        try {
        scenario.onActivity {it.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT}
        val title="MuMu 原生笔记 ${System.nanoTime()}"
        compose.waitUntil(30_000) {compose.onAllNodesWithText("本地书库 · 离线可用").fetchSemanticsNodes().isNotEmpty()}
        val tab=SemanticsMatcher.expectValue(SemanticsProperties.Role,Role.Tab)
        compose.onNode(hasText("笔记") and tab).performClick()
        compose.onNodeWithContentDescription("新建").performClick()
        compose.onNode(hasText("标题") and hasSetTextAction()).performTextInput(title)
        compose.onNode(hasText("正文 · 支持 [[双链]]") and hasSetTextAction()).performTextInput("离线保存、重启保留、中文 🚀")
        scenario.recreate()
        compose.onNodeWithText(title).assertExists()
        compose.onNode(hasText("离线保存、重启保留、中文 🚀") and hasSetTextAction()).assertExists()
        compose.onNode(hasText("保存") and hasClickAction()).performScrollTo().performClick()
        compose.waitUntil(15_000) {compose.onAllNodes(hasText("正文 · 支持 [[双链]]") and hasSetTextAction()).fetchSemanticsNodes().isEmpty()}
        compose.onNode(hasText("搜索当前列表") and hasSetTextAction()).performTextReplacement(title)
        compose.waitUntil(15_000) {compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty()}
        compose.onNode(hasText(title) and hasClickAction() and !hasSetTextAction()).assertExists()
        compose.onNode(hasText("复习") and tab).performClick()
        compose.onNodeWithText("待复习 0 张").assertIsDisplayed()
        compose.onNode(hasText("设置") and tab).performClick()
        compose.onNodeWithText("连接现有书库").assertIsDisplayed()
        } finally {scenario.close()}
    }
}
