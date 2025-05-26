// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title ISessionNameService Interface
 * @notice Interface for the Session Name Service (SNS) contract, which manages
 *         name registrations as ERC-721 NFTs.
 */
interface ISessionNameService {
    // --- Events expected to be emitted by implementations ---

    /**
     * @dev Emitted when a name is successfully registered.
     * @param name The lowercase name registered.
     * @param owner The address receiving the name NFT.
     * @param tokenId The token ID (keccak256 hash of the name) of the NFT.
     */
    event NameRegistered(string indexed name, address indexed owner, uint256 tokenId);

    /**
     * @dev Emitted when a name NFT is burned by its owner.
     * @param name The lowercase name associated with the burned token.
     * @param owner The address of the owner who initiated the burn.
     * @param tokenId The token ID of the burned NFT.
     */
    event NameDeleted(string indexed name, address indexed owner, uint256 tokenId);

    /**
     * @dev Emitted when a name's registration is successfully renewed.
     * @param name The lowercase name renewed.
     * @param owner The address of the name owner.
     * @param timestamp The block timestamp when the renewal occurred.
     */
    event NameRenewed(string indexed name, address indexed owner, uint256 timestamp);

    /**
     * @dev Emitted when an expired name NFT is burned by an authorized account (Registerer/Admin).
     * @param name The lowercase name associated with the expired token.
     * @param owner The address of the owner whose name expired.
     * @param tokenId The token ID of the expired NFT that was burned.
     */
    event NameExpired(string indexed name, address indexed owner, uint256 tokenId);

    /**
     * @dev Emitted when the text record for a name NFT is updated.
     * @param tokenId The token ID of the NFT whose record was updated.
     * @param recordType The type of record updated (1 for session, 3 for lokinet).
     * @param text The new text record string.
     */
    event TextRecordUpdated(uint256 indexed tokenId, uint8 indexed recordType, string text);

    /**
     * @dev Emitted when the payment token is set.
     * @param token The address of the new payment token.
     */
    event PaymentTokenSet(address indexed token);

    /**
     * @dev Emitted when registration and transfer fees are set.
     * @param registrationFee The new registration fee amount.
     * @param transferFee The new transfer fee amount.
     */
    event FeesSet(uint256 registrationFee, uint256 transferFee);

    /**
     * @dev Emitted when collected fees are withdrawn.
     * @param to The address that received the fees.
     * @param amount The amount of fees withdrawn.
     */
    event FeesWithdrawn(address indexed to, uint256 amount);

    // --- Functions ---

    /**
     * @notice Resolves a name to its associated text record of a specific type.
     * @param _name The name to resolve (case-insensitive).
     * @param recordType The type of record to retrieve (1 for session, 3 for lokinet).
     * @return string The text record associated with the name and type.
     * @dev Implementations should convert the name to lowercase before lookup.
     * @dev Reverts if the name is not registered.
     * @dev Returns an empty string if the name is registered but the specific record type is not set.
     */
    function resolve(string memory _name, uint8 recordType) external view returns (string memory);

    /**
     * @notice Registers a new name, minting an ERC-721 NFT to the specified owner.
     * @param to The address that will own the newly registered name NFT.
     * @param _name The name to register (case-insensitive, must be alphanumeric).
     * @return uint256 The token ID of the newly minted name NFT.
     * @dev Implementations typically require specific roles (e.g., REGISTERER_ROLE) for registration.
     * @dev Should convert the name to lowercase and ensure it's alphanumeric and not already registered.
     * @dev Should emit a `NameRegistered` event upon successful registration.
     */
    function registerName(address to, string memory _name) external returns (uint256);
}
