package org.shufang.android

import org.junit.Assert.*
import org.junit.Test

class RemoteAddressTest {
    @Test fun rejectsCredentialsPathsAndCleartext() {
        for (value in listOf("http://books.example", "https://user:secret@books.example", "https://books.example/path", "https://books.example/?token=a")) {
            assertTrue(runCatching { RemoteAddress.normalize(value) }.isFailure)
        }
    }
    @Test fun canonicalOriginIsUsedForAccountIsolation() {
        assertEquals("https://books.example", RemoteAddress.normalize("https://BOOKS.example/"))
        assertEquals("https://books.example:8443", RemoteAddress.normalize("https://books.example:8443"))
    }
}
