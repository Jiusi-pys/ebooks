package org.shufang.android

import org.junit.Assert.*
import org.junit.Test

class CredentialModeTest {
    @Test fun accountAndNodeHeadersNeverFallBackToEachOther() {
        assertEquals(mapOf("Cookie" to "shufang_session=example"),CredentialMode.headers("account","shufang_session=example"))
        assertEquals(mapOf("Authorization" to "Bearer example"),CredentialMode.headers("node","example"))
        assertTrue(runCatching {CredentialMode.headers("unknown","example")}.isFailure)
        assertTrue(runCatching {CredentialMode.headers("node","")}.isFailure)
        assertTrue(runCatching {CredentialMode.headers("account","value\r\nheader: injection")}.isFailure)
    }
}
