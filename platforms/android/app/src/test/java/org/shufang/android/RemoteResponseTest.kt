package org.shufang.android

import org.junit.Assert.*
import org.junit.Test

class RemoteResponseTest {
    @Test fun proxyHtmlKeepsHttpStatusWithoutRenderingItsBody() {
        val error=runCatching {RemoteResponse.decode(503,"text/html","<html>private proxy detail</html>")}.exceptionOrNull()!!
        assertTrue(error.message!!.contains("HTTP 503"))
        assertFalse(error.message!!.contains("private"))
    }
    @Test fun accountStoreFailureHasActionableMessageAndCode() {
        val error=runCatching {RemoteResponse.decode(503,"application/json","{\"error\":\"account_store_unavailable\"}")}.exceptionOrNull()!!
        assertTrue(error.message!!.contains("account_store_unavailable"))
        assertTrue(error.message!!.contains("服务器"))
    }
    @Test fun expiredLoginPreservesOfflineDataMessage() {
        assertTrue(runCatching {RemoteResponse.decode(401,"text/html","")}.exceptionOrNull()!!.message!!.contains("本地修改已保留"))
    }
    @Test fun successfulHtmlIsRejectedRatherThanTreatedAsAnApi() {
        assertTrue(runCatching {RemoteResponse.decode(200,"text/html","<html>SPA</html>")}.exceptionOrNull()!!.message!!.contains("JSON"))
        assertEquals(true,RemoteResponse.decode(200,"application/json","{\"ok\":true}").getBoolean("ok"))
    }
}
