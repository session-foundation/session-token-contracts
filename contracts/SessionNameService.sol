// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ISessionNameService} from "./interfaces/ISessionNameService.sol";

/**
 * @title SessionNameService (SNS)
 * @notice L2 name service contract storing names as ERC-721 NFTs.
 * @author https://getsession.org/
 * @dev Names are stored lowercase and must be alphanumeric.
 * @dev Registration requires REGISTERER_ROLE or DEFAULT_ADMIN_ROLE.
 * @dev Optional renewal/expiration mechanism managed by admin.
 */
contract SessionNameService is ISessionNameService, ERC721, ERC721Burnable, AccessControl {
    using Strings for uint256;

    // Stores NFT metadata associated with a registered name.
    struct NameAssets {
        uint256 id; // Token ID (keccak256 hash of the lowercase name)
        uint256 renewals; // Timestamp of the last renewal (or registration if never renewed)
    }

    // Stores the original (lowercase) name associated with a token ID.
    // Necessary for cleanup during burn/expire operations.
    struct LinkedNames {
        string name;
    }

    // Total number of currently registered names (active NFTs).
    uint256 private totalSupply_;
    // Role required to register names or expire them.
    bytes32 public constant REGISTERER_ROLE = keccak256("REGISTERER_ROLE");
    // Default duration for which a name registration/renewal is valid.
    uint256 public expiration = 365 days;
    // Base URI for constructing token URIs (metadata).
    string public baseTokenURI;
    // Flag controlled by admin to enable/disable the renewal and expiration features.
    bool public allowRenewals;

    // Maps lowercase name string to its corresponding NFT asset data.
    mapping(string => NameAssets) public namesToAssets;
    // Maps token ID (hash of name) back to its original lowercase name string.
    mapping(uint256 => LinkedNames) public idsToNames;
    // Maps token ID to its associated text record.
    mapping(uint256 => string) public tokenIdToTextRecord;

    // Custom Errors
    error InvalidInputLengths();
    error NameNotRegistered();
    error NotNameOwner();
    error RenewalPeriodNotOver();
    error NullName();
    error UnsupportedCharacters();
    error NameAlreadyRegistered();
    error NotAuthorized();
    error RenewalsDisabled();
    error InvalidExpirationDuration();
    error ExpirationDurationTooLong();

    /**
     * @notice Deploys the SessionNameService contract.
     * @param baseURI Base URI for token metadata.
     * @dev Grants DEFAULT_ADMIN_ROLE to the deployer.
     */
    constructor(string memory baseURI) ERC721("SessionNameService", "SNS") {
        baseTokenURI = baseURI;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Resolves a name to its associated text record.
     * @param _name The name to resolve (case-insensitive).
     * @return string The text record, or empty string if not set.
     * @dev Reverts if name not registered.
     */
    function resolve(string memory _name) external view override returns (string memory) {
        _name = toLower(_name);
        uint256 hashOfName = uint256(keccak256(abi.encodePacked(_name)));

        if (bytes(idsToNames[hashOfName].name).length == 0) revert NameNotRegistered();

        return tokenIdToTextRecord[hashOfName];
    }

    /**
     * @notice Returns the total number of registered names (NFTs).
     */
    function totalSupply() external view returns (uint256) {
        return totalSupply_;
    }

    /**
     * @notice Registers multiple names in a single transaction.
     * @param to Array of addresses to receive the name NFTs.
     * @param _name Array of names to register.
     * @dev Requires REGISTERER_ROLE or DEFAULT_ADMIN_ROLE.
     * @dev Both arrays must have the same length.
     * @dev Calls internal `registerName` for each entry.
     * @dev Transaction is atomic; if one registration fails, the entire batch reverts.
     */
    function registerNameMultiple(address[] memory to, string[] memory _name) external onlyRegisterer {
        if (to.length != _name.length) revert InvalidInputLengths();

        for (uint256 i = 0; i < to.length; i++) {
            registerName(to[i], _name[i]);
        }
    }

    /**
     * @notice Renews a name registration, updating its renewal timestamp.
     * @param _name Name to renew (case-insensitive).
     * @dev Requires allowRenewals to be true.
     * @dev Caller must be the owner of the name NFT.
     */
    function renewName(string memory _name) external isRenewalsAllowed {
        _name = toLower(_name);
        NameAssets storage asset = namesToAssets[_name];

        if (asset.id == 0) revert NameNotRegistered();
        address owner = _requireOwned(asset.id);
        if (owner != msg.sender) revert ERC721IncorrectOwner(msg.sender, asset.id, owner);

        uint256 currentTime = block.timestamp;
        asset.renewals = currentTime;

        emit NameRenewed(_name, owner, currentTime);
    }

    /**
     * @notice Burns a name NFT if its expiration period has passed.
     * @param _name Name to expire (case-insensitive).
     * @dev Requires allowRenewals to be true and caller to have REGISTERER_ROLE.
     * @dev Cleans up all relevant storage entries when successful.
     */
    function expireName(string memory _name) external isRenewalsAllowed onlyRegisterer {
        _name = toLower(_name);
        NameAssets memory asset = namesToAssets[_name];
        uint256 tokenId = asset.id;

        if (tokenId == 0) revert NameNotRegistered();
        if (asset.renewals + expiration >= block.timestamp) revert RenewalPeriodNotOver();

        address owner = ownerOf(tokenId);
        delete idsToNames[tokenId];
        delete namesToAssets[_name];
        delete tokenIdToTextRecord[tokenId];

        emit NameExpired(_name, owner, tokenId);

        _burn(tokenId); // This handles the Transfer event.
        // Explicitly decrement supply after successful expiration.
        if (totalSupply_ > 0) {
            // Prevent underflow
            totalSupply_--;
        }
    }

    /**
     * @notice Updates the base URI for token metadata.
     * @param baseURI_ The new base URI string.
     * @dev Requires DEFAULT_ADMIN_ROLE.
     */
    function setBaseTokenURI(string memory baseURI_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseTokenURI = baseURI_;
    }

    /**
     * @notice Enables or disables the renewal and expiration features.
     * @dev Requires DEFAULT_ADMIN_ROLE.
     */
    function flipRenewals() external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowRenewals = !allowRenewals;
    }

    /**
     * @notice Sets the expiration duration for names.
     * @param newExpirationDuration The new duration in seconds.
     * @dev Requires DEFAULT_ADMIN_ROLE.
     * @dev Duration must be between 30 days and 100 years.
     */
    function setExpirationDuration(uint256 newExpirationDuration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newExpirationDuration < 30 days) revert InvalidExpirationDuration();
        if (newExpirationDuration > 100 * 365 days) revert ExpirationDurationTooLong();

        expiration = newExpirationDuration;
    }

    /**
     * @notice Registers a single name and mints the corresponding NFT.
     * @param to The address to receive the NFT.
     * @param _name The name to register (case-insensitive, alphanumeric).
     * @return uint256 The token ID of the newly minted NFT.
     * @dev Validates name (non-empty, alphanumeric, unique).
     */
    function registerName(address to, string memory _name) public onlyRegisterer returns (uint256) {
        _name = toLower(_name);
        if (bytes(_name).length == 0) revert NullName();
        if (!isAlphanumeric(_name)) revert UnsupportedCharacters();
        if (namesToAssets[_name].id != 0) revert NameAlreadyRegistered();

        uint256 newTokenId = uint256(keccak256(abi.encodePacked(_name)));
        namesToAssets[_name] = NameAssets(newTokenId, block.timestamp);
        idsToNames[newTokenId].name = _name;
        tokenIdToTextRecord[newTokenId] = "";

        _safeMint(to, newTokenId); // Calls standard OpenZeppelin _safeMint.
        totalSupply_++; // Increment supply after successful mint
        emit NameRegistered(_name, to, newTokenId);
        return newTokenId;
    }

    /**
     * @inheritdoc ERC721
     * @dev Constructs the token URI by concatenating the `baseTokenURI` and `tokenId`.
     * @dev Returns an empty string if `baseTokenURI` is not set.
     * @dev Reverts with `ERC721NonexistentToken` if `tokenId` does not exist.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory base = baseTokenURI;
        return bytes(base).length > 0 ? string.concat(base, tokenId.toString()) : "";
    }

    /**
     * @inheritdoc ERC721
     * @dev Declares support for ISessionNameService, ERC721, and AccessControl interfaces.
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return type(ISessionNameService).interfaceId == interfaceId || super.supportsInterface(interfaceId);
    }

    /**
     * @inheritdoc ERC721Burnable
     * @dev Extends the standard burn functionality to also clean up SNS-specific storage.
     * @dev Deletes entries from `namesToAssets` and `idsToNames`.
     * @dev Emits `NameDeleted` event.
     * @dev Decrements `totalSupply_` after successful burn.
     */
    function burn(uint256 tokenId) public override(ERC721Burnable) {
        address owner = _requireOwned(tokenId);
        string memory _name = idsToNames[tokenId].name;

        delete idsToNames[tokenId];
        delete tokenIdToTextRecord[tokenId];
        if (bytes(_name).length > 0) {
            delete namesToAssets[_name];
        }

        emit NameDeleted(_name, owner, tokenId);

        super.burn(tokenId); // Handles Transfer event and calls internal OZ _burn.
        // Decrement supply after successful burn.
        if (totalSupply_ > 0) {
            // Prevent underflow
            totalSupply_--;
        }
    }

    /**
     * @notice Converts an ASCII string to lowercase.
     * @param str The input string.
     * @return string The lowercase string.
     */
    function toLower(string memory str) private pure returns (string memory) {
        bytes memory bStr = bytes(str);
        bytes memory bLower = new bytes(bStr.length);
        for (uint i = 0; i < bStr.length; i++) {
            // ASCII 'A'=65, 'Z'=90
            if ((uint8(bStr[i]) >= 65) && (uint8(bStr[i]) <= 90)) {
                bLower[i] = bytes1(uint8(bStr[i]) + 32);
            } else {
                bLower[i] = bStr[i];
            }
        }
        return string(bLower);
    }

    /**
     * @notice Checks if a string contains only lowercase alphanumeric ASCII characters (a-z, 0-9).
     * @param str The input string.
     * @return bool True if the string is valid, false otherwise.
     */
    function isAlphanumeric(string memory str) private pure returns (bool) {
        bytes memory b = bytes(str);
        for (uint i = 0; i < b.length; i++) {
            bytes1 char = b[i];
            // ASCII '0'=48, '9'=57, 'a'=97, 'z'=122
            if (
                !(char >= 0x30 && char <= 0x39) && !(char >= 0x61 && char <= 0x7A) // 0-9 // a-z
            ) {
                return false;
            }
        }
        return true;
    }

    /**
     * @notice Sets a text record associated with a specific token ID.
     * @param tokenId The token ID to set the record for.
     * @param text The text data to associate with the token ID.
     * @dev Only the owner or approved operators can set the text record.
     */
    function setTextRecord(uint256 tokenId, string calldata text) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && getApproved(tokenId) != msg.sender && !isApprovedForAll(owner, msg.sender)) {
            revert NotAuthorized();
        }
        tokenIdToTextRecord[tokenId] = text;
        emit TextRecordUpdated(tokenId, text);
    }

    // --- Modifiers ---

    /**
     * @dev Modifier restricting to REGISTERER_ROLE or DEFAULT_ADMIN_ROLE.
     */
    modifier onlyRegisterer() {
        if (!(hasRole(REGISTERER_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender))) revert NotAuthorized();
        _;
    }

    /**
     * @dev Modifier requiring the renewal feature to be enabled.
     */
    modifier isRenewalsAllowed() {
        if (!allowRenewals) revert RenewalsDisabled();
        _;
    }
}
